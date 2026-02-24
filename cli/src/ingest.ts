import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import yaml from "js-yaml";
import { z } from "zod";

type Direction = "debit" | "credit" | "neutral";

type SankeyNode = { name: string };
type SankeyLink = { source: number; target: number; value: number };

type NormalizedTransaction = {
  id: string;
  date: string;
  accountId: string;
  narrative: string;
  narrativeNormalized: string;
  merchant: string;
  debitAmount: number;
  creditAmount: number;
  amount: number;
  direction: Direction;
  balance: number | null;
  sourceCategory: string;
  category: string;
  categoryReason: string;
};

type CliOptions = {
  input: string;
  outDir: string;
  rulesFile: string;
  overridesFile: string;
  publishWeb: boolean;
};

type CategoryRulesFile = {
  rules?: Record<string, string[]>;
};

type OverridesFile = {
  overrides?: Record<string, string>;
  narrative_contains?: Record<string, string>;
};

const bankRowSchema = z.object({
  "Bank Account": z.string(),
  Date: z.string(),
  Narrative: z.string(),
  "Debit Amount": z.string().optional(),
  "Credit Amount": z.string().optional(),
  Balance: z.string().optional(),
  Categories: z.string().optional(),
  Serial: z.string().optional()
});

const EXCLUDED_SPEND_CATEGORIES = new Set(["Income", "Transfers"]);

function findProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJsonRaw = fs.readFileSync(packageJsonPath, "utf8");
        const packageJson = JSON.parse(packageJsonRaw) as { workspaces?: unknown };
        if (Array.isArray(packageJson.workspaces)) {
          return current;
        }
      } catch {
        // Keep walking upward.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

function resolveFromRoot(rootDir: string, value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(rootDir, value);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    input: "Data_export_23022026.csv",
    outDir: path.join("data", "processed"),
    rulesFile: path.join("rules", "categories.yml"),
    overridesFile: path.join("rules", "overrides.yml"),
    publishWeb: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" && argv[i + 1]) {
      options.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--out-dir" && argv[i + 1]) {
      options.outDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--rules" && argv[i + 1]) {
      options.rulesFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--overrides" && argv[i + 1]) {
      options.overridesFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--no-publish-web") {
      options.publishWeb = false;
      continue;
    }
  }

  return options;
}

function parseMoney(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) {
    return 0;
  }
  const numeric = Number.parseFloat(cleaned);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseDate(dateValue: string): string {
  const trimmed = dateValue.trim();
  const parts = trimmed.split("/");
  if (parts.length !== 3) {
    throw new Error(`Unsupported date format: ${dateValue}`);
  }
  const [dayStr, monthStr, yearStr] = parts;
  const day = Number.parseInt(dayStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const year = Number.parseInt(yearStr, 10);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
    throw new Error(`Invalid date parts: ${dateValue}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function inferMerchant(narrative: string): string {
  const cleaned = narrative
    .replace(/\s+/g, " ")
    .replace(/^DEPOSIT[-\s]OSKO PAYMENT\s+\d+\s+/i, "")
    .replace(/^WITHDRAWAL[-\s]OSKO PAYMENT\s+\d+\s+/i, "")
    .replace(/^WITHDRAWAL MOBILE\s+\d+\s+TFR\s+/i, "")
    .replace(/^PAYMENT BY AUTHORITY TO\s+/i, "")
    .replace(/^DEPOSIT\s+/i, "")
    .trim();

  return cleaned || narrative.trim();
}

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return `tx_${hash.toString(16).padStart(8, "0")}`;
}

function loadYamlFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = yaml.load(content);
  if (!parsed || typeof parsed !== "object") {
    return fallback;
  }
  return parsed as T;
}

function buildCategoryMatcher(
  rulesFile: CategoryRulesFile,
  overridesFile: OverridesFile
): {
  categoryFor: (transaction: Omit<NormalizedTransaction, "category" | "categoryReason">) => {
    category: string;
    reason: string;
  };
} {
  const overridesById = Object.entries(overridesFile.overrides ?? {}).map(([id, category]) => [id.trim(), category.trim()]);
  const narrativeOverrides = Object.entries(overridesFile.narrative_contains ?? {}).map(([needle, category]) => [
    normalizeText(needle),
    category.trim()
  ]);
  const ruleEntries = Object.entries(rulesFile.rules ?? {}).map(([category, needles]) => ({
    category,
    needles: needles.map((needle) => normalizeText(needle))
  }));

  return {
    categoryFor(transaction) {
      const idOverride = overridesById.find(([id]) => id === transaction.id);
      if (idOverride) {
        return { category: idOverride[1], reason: "override:id" };
      }

      const narrativeOverride = narrativeOverrides.find(([needle]) => transaction.narrativeNormalized.includes(needle));
      if (narrativeOverride) {
        return { category: narrativeOverride[1], reason: `override:narrative:${narrativeOverride[0]}` };
      }

      for (const entry of ruleEntries) {
        const matchedNeedle = entry.needles.find((needle) => transaction.narrativeNormalized.includes(needle));
        if (matchedNeedle) {
          return { category: entry.category, reason: `rule:${matchedNeedle}` };
        }
      }

      if (transaction.direction === "credit") {
        return { category: "Income", reason: "fallback:credit" };
      }

      if (transaction.sourceCategory.toUpperCase() === "INT") {
        return { category: "Interest", reason: "fallback:sourceCategory=INT" };
      }

      return { category: "Uncategorized", reason: "fallback:uncategorized" };
    }
  };
}

function readCsvRows(inputPath: string): Array<z.infer<typeof bankRowSchema>> {
  const csvRaw = fs.readFileSync(inputPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(csvRaw, {
    header: true,
    skipEmptyLines: true
  });

  if (parsed.errors.length > 0) {
    const firstError = parsed.errors[0];
    throw new Error(`CSV parse error at row ${firstError.row ?? "unknown"}: ${firstError.message}`);
  }

  return parsed.data
    .map((row) => bankRowSchema.parse(row))
    .filter((row) => row.Date.trim().length > 0 && row.Narrative.trim().length > 0);
}

function normalizeTransactions(
  rows: Array<z.infer<typeof bankRowSchema>>,
  categoryFor: (transaction: Omit<NormalizedTransaction, "category" | "categoryReason">) => {
    category: string;
    reason: string;
  }
): NormalizedTransaction[] {
  return rows.map((row, index) => {
    const debitAmount = parseMoney(row["Debit Amount"]);
    const creditAmount = parseMoney(row["Credit Amount"]);
    const amount = debitAmount > 0 ? debitAmount : creditAmount > 0 ? -creditAmount : 0;
    const direction: Direction = debitAmount > 0 ? "debit" : creditAmount > 0 ? "credit" : "neutral";
    const narrative = row.Narrative.trim();
    const narrativeNormalized = normalizeText(narrative);
    const idSignature = [
      row.Date.trim(),
      row["Bank Account"].trim(),
      narrativeNormalized,
      debitAmount.toFixed(2),
      creditAmount.toFixed(2),
      row.Serial?.trim() || String(index)
    ].join("|");
    const id = hashString(idSignature);

    const baseTransaction: Omit<NormalizedTransaction, "category" | "categoryReason"> = {
      id,
      date: parseDate(row.Date),
      accountId: row["Bank Account"].trim(),
      narrative,
      narrativeNormalized,
      merchant: inferMerchant(narrative),
      debitAmount,
      creditAmount,
      amount,
      direction,
      balance: row.Balance ? parseMoney(row.Balance) : null,
      sourceCategory: (row.Categories ?? "").trim()
    };

    const categorization = categoryFor(baseTransaction);

    return {
      ...baseTransaction,
      category: categorization.category,
      categoryReason: categorization.reason
    };
  });
}

function buildSankeyData(transactions: NormalizedTransaction[]): {
  generatedAt: string;
  currency: string;
  nodes: SankeyNode[];
  links: SankeyLink[];
  summary: {
    totalSpend: number;
    transactionCount: number;
  };
} {
  const spendTransactions = transactions.filter(
    (transaction) =>
      transaction.direction === "debit" &&
      transaction.amount > 0 &&
      !EXCLUDED_SPEND_CATEGORIES.has(transaction.category)
  );

  const categoryTotals = new Map<string, number>();
  const merchantTotalsByCategory = new Map<string, Map<string, number>>();

  for (const transaction of spendTransactions) {
    categoryTotals.set(transaction.category, (categoryTotals.get(transaction.category) ?? 0) + transaction.amount);

    if (!merchantTotalsByCategory.has(transaction.category)) {
      merchantTotalsByCategory.set(transaction.category, new Map<string, number>());
    }
    const merchantTotals = merchantTotalsByCategory.get(transaction.category);
    if (!merchantTotals) {
      continue;
    }
    merchantTotals.set(transaction.merchant, (merchantTotals.get(transaction.merchant) ?? 0) + transaction.amount);
  }

  const nodes: SankeyNode[] = [{ name: "Total Spend" }];
  const nodeIndex = new Map<string, number>([["Total Spend", 0]]);

  const sortedCategories = [...categoryTotals.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [category] of sortedCategories) {
    nodeIndex.set(category, nodes.length);
    nodes.push({ name: category });
  }

  for (const [category, merchants] of merchantTotalsByCategory.entries()) {
    for (const merchant of merchants.keys()) {
      if (!nodeIndex.has(merchant)) {
        nodeIndex.set(merchant, nodes.length);
        nodes.push({ name: merchant });
      }
    }
  }

  const links: SankeyLink[] = [];

  for (const [category, total] of sortedCategories) {
    const source = nodeIndex.get("Total Spend");
    const target = nodeIndex.get(category);
    if (source === undefined || target === undefined) {
      continue;
    }
    links.push({ source, target, value: Number(total.toFixed(2)) });

    const merchants = merchantTotalsByCategory.get(category);
    if (!merchants) {
      continue;
    }

    const sortedMerchants = [...merchants.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [merchant, merchantTotal] of sortedMerchants) {
      const merchantIndex = nodeIndex.get(merchant);
      if (merchantIndex === undefined) {
        continue;
      }
      links.push({
        source: target,
        target: merchantIndex,
        value: Number(merchantTotal.toFixed(2))
      });
    }
  }

  const totalSpend = [...categoryTotals.values()].reduce((sum, value) => sum + value, 0);

  return {
    generatedAt: new Date().toISOString(),
    currency: "AUD",
    nodes,
    links,
    summary: {
      totalSpend: Number(totalSpend.toFixed(2)),
      transactionCount: spendTransactions.length
    }
  };
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = findProjectRoot(process.cwd());
  const inputPath = resolveFromRoot(projectRoot, options.input);
  const outDir = resolveFromRoot(projectRoot, options.outDir);
  const rulesPath = resolveFromRoot(projectRoot, options.rulesFile);
  const overridesPath = resolveFromRoot(projectRoot, options.overridesFile);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file does not exist: ${inputPath}`);
  }

  const rulesConfig = loadYamlFile<CategoryRulesFile>(rulesPath, { rules: {} });
  const overridesConfig = loadYamlFile<OverridesFile>(overridesPath, {
    overrides: {},
    narrative_contains: {}
  });
  const matcher = buildCategoryMatcher(rulesConfig, overridesConfig);

  const rows = readCsvRows(inputPath);
  const transactions = normalizeTransactions(rows, matcher.categoryFor);
  const sankey = buildSankeyData(transactions);
  const uncategorized = transactions.filter(
    (transaction) => transaction.direction === "debit" && transaction.category === "Uncategorized"
  );

  writeJsonFile(path.join(outDir, "transactions.json"), transactions);
  writeJsonFile(path.join(outDir, "sankey.json"), sankey);
  writeJsonFile(path.join(outDir, "uncategorized.json"), uncategorized);

  if (options.publishWeb) {
    const webPublicDir = path.join(projectRoot, "web", "public");
    if (fs.existsSync(webPublicDir)) {
      writeJsonFile(path.join(webPublicDir, "sankey.json"), sankey);
      writeJsonFile(path.join(webPublicDir, "uncategorized.json"), uncategorized);
      writeJsonFile(path.join(webPublicDir, "transactions.json"), transactions);
    }
  }

  const categoryCounts = transactions.reduce<Record<string, number>>((acc, transaction) => {
    acc[transaction.category] = (acc[transaction.category] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`Input rows: ${rows.length}`);
  console.log(`Normalized transactions: ${transactions.length}`);
  console.log(`Sankey spend transactions: ${sankey.summary.transactionCount}`);
  console.log(`Total spend: ${sankey.currency} ${sankey.summary.totalSpend.toFixed(2)}`);
  console.log(`Uncategorized debit transactions: ${uncategorized.length}`);
  console.log("Category counts:", categoryCounts);
  console.log(`Wrote output to: ${outDir}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Ingestion failed:", message);
  process.exit(1);
}
