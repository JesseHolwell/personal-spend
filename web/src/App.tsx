import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, Sankey, Tooltip } from "recharts";

type RawTransaction = {
  id: string;
  date: string;
  accountId: string;
  merchant: string;
  narrative: string;
  amount: number;
  direction: "debit" | "credit" | "neutral";
  category: string;
  categoryReason: string;
};

type UncategorizedTransaction = {
  id: string;
  date: string;
  merchant: string;
  amount: number;
  narrative: string;
  categoryReason: string;
};

type SankeyMeta = {
  generatedAt: string;
  currency: string;
};

type VizNode = {
  name: string;
  kind: "income" | "total" | "category" | "savings";
  color: string;
  value: number;
  percent?: number;
  labelMain?: string;
  labelSub?: string;
};

type VizLink = {
  source: number;
  target: number;
  value: number;
  color: string;
  kind: "income" | "category" | "savings";
};

type VizData = {
  nodes: VizNode[];
  links: VizLink[];
};

type AccountStat = {
  source: string;
  total: number;
  percent: number;
  color: string;
};

type CategoryStat = {
  category: string;
  total: number;
  percent: number;
  count: number;
  color: string;
};

type BuildVizResult = {
  sankey: VizData;
  totalIncome: number;
  totalSpend: number;
  savings: number;
  spendCount: number;
  incomeStats: AccountStat[];
  categoryStats: CategoryStat[];
  outflowCount: number;
};

type RechartsSankeyNode = {
  name?: string;
  kind?: "income" | "total" | "category" | "savings";
  color?: string;
  labelMain?: string;
  labelSub?: string;
};

type RechartsSankeyLinkPayload = {
  source?: RechartsSankeyNode;
  target?: RechartsSankeyNode;
  value?: number;
  color?: string;
  kind?: "income" | "category" | "savings";
};

const EXCLUDED_CATEGORIES = new Set(["Transfers", "Income"]);

const CATEGORY_COLORS = [
  "#36b8ac",
  "#6b67f2",
  "#8f45e8",
  "#35bf72",
  "#8a62de",
  "#f48b2b",
  "#3d73e6",
  "#eb59a7",
  "#2ca2f6",
  "#ef5e4a",
  "#fc845b",
  "#8f9eb4",
  "#79c81d",
  "#d18f2f"
];

const ACCOUNT_COLORS = ["#2f9ef6", "#4db7ff", "#18c5d5"];

const EMPTY_VIZ: BuildVizResult = {
  sankey: { nodes: [], links: [] },
  totalIncome: 0,
  totalSpend: 0,
  savings: 0,
  spendCount: 0,
  incomeStats: [],
  categoryStats: [],
  outflowCount: 0
};

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

function formatPercent(value: number): string {
  if (value > 0 && value < 0.01) {
    return "<1%";
  }
  return `${Math.round(value * 100)}%`;
}

function buildVisualization(transactions: RawTransaction[], currency: string): BuildVizResult {
  const incomeBySource = new Map<string, number>();
  const categorizedIncomeTransactions = transactions.filter(
    (transaction) => transaction.direction === "credit" && transaction.amount < 0 && transaction.category === "Income"
  );
  const fallbackIncomeTransactions = transactions.filter(
    (transaction) =>
      transaction.direction === "credit" &&
      transaction.amount < 0 &&
      transaction.category !== "Transfers"
  );
  const incomeTransactions = categorizedIncomeTransactions.length > 0 ? categorizedIncomeTransactions : fallbackIncomeTransactions;

  for (const transaction of incomeTransactions) {
    const sourceName = transaction.merchant || transaction.narrative || "Income";
    const amount = Math.abs(transaction.amount);
    incomeBySource.set(sourceName, (incomeBySource.get(sourceName) ?? 0) + amount);
  }

  const rawIncomeSources = [...incomeBySource.entries()].sort((a, b) => b[1] - a[1]);
  const compactIncomeSources = rawIncomeSources.slice(0, 3);
  if (rawIncomeSources.length > 3) {
    const otherTotal = rawIncomeSources.slice(3).reduce((sum, [, value]) => sum + value, 0);
    if (otherTotal > 0) {
      compactIncomeSources.push(["Other Income", otherTotal]);
    }
  }

  const totalIncome = compactIncomeSources.reduce((sum, [, total]) => sum + total, 0);

  const incomeStats = compactIncomeSources.map(([source, total], index) => ({
    source,
    total,
    percent: totalIncome > 0 ? total / totalIncome : 0,
    color: ACCOUNT_COLORS[index % ACCOUNT_COLORS.length]
  }));

  const spendTransactions = transactions.filter(
    (transaction) =>
      transaction.direction === "debit" &&
      transaction.amount > 0 &&
      !EXCLUDED_CATEGORIES.has(transaction.category)
  );

  const totalSpend = spendTransactions.reduce((sum, transaction) => sum + transaction.amount, 0);
  const savings = Math.max(0, totalIncome - totalSpend);

  const categoryTotals = new Map<string, { total: number; count: number }>();

  for (const transaction of spendTransactions) {
    const existing = categoryTotals.get(transaction.category);
    if (existing) {
      existing.total += transaction.amount;
      existing.count += 1;
    } else {
      categoryTotals.set(transaction.category, { total: transaction.amount, count: 1 });
    }
  }

  const categoryStats = [...categoryTotals.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([category, summary], index) => ({
      category,
      total: summary.total,
      count: summary.count,
      percent: totalSpend > 0 ? summary.total / totalSpend : 0,
      color: CATEGORY_COLORS[index % CATEGORY_COLORS.length]
    }));

  const outflowStats = [...categoryStats];
  if (savings > 0) {
    outflowStats.push({
      category: "Savings",
      total: savings,
      count: 0,
      percent: totalIncome > 0 ? savings / totalIncome : 0,
      color: "#49d3a2"
    });
  }

  const nodes: VizNode[] = [];
  const links: VizLink[] = [];
  const nodeIndex = new Map<string, number>();

  for (const income of incomeStats) {
    const key = `income:${income.source}`;
    nodeIndex.set(key, nodes.length);
    nodes.push({
      name: income.source,
      kind: "income",
      color: income.color,
      value: income.total,
      percent: income.percent,
      labelMain: income.source,
      labelSub: `${formatCurrency(income.total, currency)} | ${formatPercent(income.percent)}`
    });
  }

  const totalNodeKey = "total:income";
  nodeIndex.set(totalNodeKey, nodes.length);
  nodes.push({
    name: "Total Income",
    kind: "total",
    color: "#7f8b98",
    value: totalIncome,
    percent: 1,
    labelMain: "Total Income",
    labelSub: formatCurrency(totalIncome, currency)
  });

  for (const outflow of outflowStats) {
    const key = outflow.category === "Savings" ? "savings:bucket" : `category:${outflow.category}`;
    nodeIndex.set(key, nodes.length);
    nodes.push({
      name: outflow.category,
      kind: outflow.category === "Savings" ? "savings" : "category",
      color: outflow.color,
      value: outflow.total,
      percent: totalIncome > 0 ? outflow.total / totalIncome : 0,
      labelMain: outflow.category,
      labelSub: `${formatCurrency(outflow.total, currency)} | ${formatPercent(totalIncome > 0 ? outflow.total / totalIncome : 0)}`
    });
  }

  const totalNodeIndex = nodeIndex.get(totalNodeKey);
  if (totalNodeIndex === undefined) {
    return EMPTY_VIZ;
  }

  for (const income of incomeStats) {
    const source = nodeIndex.get(`income:${income.source}`);
    if (source === undefined) {
      continue;
    }
    links.push({
      source,
      target: totalNodeIndex,
      value: Number(income.total.toFixed(2)),
      color: income.color,
      kind: "income"
    });
  }

  for (const outflow of outflowStats) {
    const target = nodeIndex.get(outflow.category === "Savings" ? "savings:bucket" : `category:${outflow.category}`);
    if (target === undefined) {
      continue;
    }
    links.push({
      source: totalNodeIndex,
      target,
      value: Number(outflow.total.toFixed(2)),
      color: outflow.color,
      kind: outflow.category === "Savings" ? "savings" : "category"
    });
  }

  return {
    sankey: { nodes, links },
    totalIncome: Number(totalIncome.toFixed(2)),
    totalSpend: Number(totalSpend.toFixed(2)),
    savings: Number(savings.toFixed(2)),
    spendCount: spendTransactions.length,
    incomeStats,
    categoryStats,
    outflowCount: outflowStats.length
  };
}

function LinkShape(props: {
  sourceX: number;
  sourceY: number;
  sourceControlX: number;
  targetX: number;
  targetY: number;
  targetControlX: number;
  linkWidth: number;
  payload: RechartsSankeyLinkPayload;
}) {
  const {
    sourceX,
    sourceY,
    sourceControlX,
    targetX,
    targetY,
    targetControlX,
    linkWidth,
    payload
  } = props;

  const path = `M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`;
  const shoulder = Math.max(8, Math.min(26, (targetX - sourceX) * 0.12));
  const startX = sourceX + shoulder;
  const endX = targetX - shoulder;
  const pathWithShoulders = endX > startX
    ? `M${sourceX},${sourceY} L${startX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${endX},${targetY} L${targetX},${targetY}`
    : path;

  return (
    <path
      d={pathWithShoulders}
      fill="none"
      stroke={payload.color ?? "#8ea0b2"}
      strokeOpacity={payload.kind === "income" ? 0.62 : 0.74}
      strokeWidth={Math.max(linkWidth, 1)}
      strokeLinecap="butt"
    />
  );
}

function NodeShape(props: {
  x: number;
  y: number;
  width: number;
  height: number;
  payload: RechartsSankeyNode;
}) {
  const { x, y, width, height, payload } = props;

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={2} fill="#bcc4cc" fillOpacity={0.95} />
      <rect
        x={payload.kind === "category" ? x : x + width - 3}
        y={y}
        width={3}
        height={height}
        fill={payload.color ?? "#5f6b79"}
        opacity={0.94}
      />
      {payload.kind === "total" ? (
        <rect x={x + width / 2 - 1} y={y} width={2} height={height} fill="#6e7b8a" opacity={0.42} />
      ) : null}
      {(payload.kind === "category" || payload.kind === "savings") ? (
        <g className="sankey-label">
          <rect x={x + width + 12} y={y + height / 2 - 12} width={24} height={24} rx={8} className="sankey-chip" />
          <rect x={x + width + 21} y={y + height / 2 - 3} width={6} height={6} rx={2} fill={payload.color ?? "#5f6b79"} />
          <text x={x + width + 46} y={y + height / 2 - 1} textAnchor="start" className="sankey-label-main">
            {payload.labelMain}
          </text>
          <text x={x + width + 46} y={y + height / 2 + 16} textAnchor="start" className="sankey-label-sub">
            {payload.labelSub}
          </text>
        </g>
      ) : null}
      {payload.kind === "income" ? (
        <g className="sankey-label">
          <text x={x - 12} y={y + height / 2 - 1} textAnchor="end" className="sankey-label-main">
            {payload.labelMain}
          </text>
          <text x={x - 12} y={y + height / 2 + 16} textAnchor="end" className="sankey-label-sub">
            {payload.labelSub}
          </text>
        </g>
      ) : null}
      {payload.kind === "total" ? (
        <g className="sankey-label">
          <text x={x + width / 2} y={Math.max(14, y - 16)} textAnchor="middle" className="sankey-label-main">
            {payload.labelMain}
          </text>
          <text x={x + width / 2} y={Math.max(29, y - 1)} textAnchor="middle" className="sankey-label-sub">
            {payload.labelSub}
          </text>
        </g>
      ) : null}
    </g>
  );
}

function FlowTooltip({
  active,
  payload,
  currency
}: {
  active?: boolean;
  payload?: Array<{ payload?: RechartsSankeyLinkPayload }>;
  currency: string;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const item = payload[0]?.payload;
  if (!item?.source || !item?.target || typeof item.value !== "number") {
    return null;
  }

  return (
    <div className="flow-tooltip">
      <p>{item.source.name} -&gt; {item.target.name}</p>
      <strong>{formatCurrency(item.value, currency)}</strong>
    </div>
  );
}

export default function App() {
  const [transactions, setTransactions] = useState<RawTransaction[]>([]);
  const [uncategorized, setUncategorized] = useState<UncategorizedTransaction[]>([]);
  const [meta, setMeta] = useState<SankeyMeta>({ generatedAt: "", currency: "AUD" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [transactionsResponse, uncategorizedResponse, sankeyMetaResponse] = await Promise.all([
          fetch("/transactions.json"),
          fetch("/uncategorized.json"),
          fetch("/sankey.json")
        ]);

        if (!transactionsResponse.ok) {
          throw new Error("Missing /transactions.json. Run ingestion first.");
        }

        const transactionsJson = (await transactionsResponse.json()) as RawTransaction[];
        setTransactions(transactionsJson);

        if (uncategorizedResponse.ok) {
          const uncategorizedJson = (await uncategorizedResponse.json()) as UncategorizedTransaction[];
          setUncategorized(uncategorizedJson);
        }

        if (sankeyMetaResponse.ok) {
          const sankeyMetaJson = (await sankeyMetaResponse.json()) as { generatedAt?: string; currency?: string };
          setMeta({
            generatedAt: sankeyMetaJson.generatedAt ?? "",
            currency: sankeyMetaJson.currency ?? "AUD"
          });
        }
      } catch (loadError) {
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        setError(message);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  const viz = useMemo(() => buildVisualization(transactions, meta.currency), [transactions, meta.currency]);
  const flowTitle = "Flow: Income -> Spending + Savings";
  const chartHeight = useMemo(() => {
    const branchCount = Math.max(viz.outflowCount, viz.incomeStats.length, 1);
    const dynamicHeight = 280 + branchCount * 30;
    return Math.max(360, Math.min(620, dynamicHeight));
  }, [viz.outflowCount, viz.incomeStats.length]);
  const nodePadding = useMemo(() => {
    const branchCount = viz.outflowCount;
    if (branchCount >= 14) {
      return 12;
    }
    if (branchCount >= 10) {
      return 18;
    }
    return 24;
  }, [viz.outflowCount]);

  const subtitle = useMemo(() => {
    if (!meta.generatedAt) {
      return "No processed dataset loaded";
    }
    return `Generated ${new Date(meta.generatedAt).toLocaleString("en-AU")}`;
  }, [meta.generatedAt]);

  if (loading) {
    return (
      <main className="page-shell">
        <p>Loading Sankey dataset...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="page-shell">
        <h1>Personal Spend Sankey</h1>
        <p className="error">{error}</p>
        <p className="hint">Run `npm run ingest -- --input ./Data_export_23022026.csv` then reload.</p>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <header className="hero">
        <p className="eyebrow">Personal Spend</p>
        <h1>Sankey Flow</h1>
        <p className="subtitle">{subtitle}</p>
      </header>

      <section className="stats">
        <article>
          <h2>Total Income</h2>
          <p>{formatCurrency(viz.totalIncome, meta.currency)}</p>
        </article>
        <article>
          <h2>Total Spend</h2>
          <p>{formatCurrency(viz.totalSpend, meta.currency)}</p>
        </article>
        <article>
          <h2>Savings</h2>
          <p>{formatCurrency(viz.savings, meta.currency)}</p>
        </article>
        <article>
          <h2>Uncategorized</h2>
          <p>{uncategorized.length}</p>
        </article>
      </section>

      <section className="studio">
        <div className="canvas-panel">
          <div className="canvas-header">
            <h2>{flowTitle}</h2>
          </div>

          <div className="chart" style={{ height: chartHeight }}>
            <ResponsiveContainer width="100%" height={chartHeight}>
              <Sankey
                data={viz.sankey}
                nodePadding={nodePadding}
                nodeWidth={15}
                linkCurvature={0.3}
                iterations={64}
                sort={false}
                margin={{ top: 34, right: 340, bottom: 20, left: 220 }}
                node={NodeShape}
                link={LinkShape}
              >
                <Tooltip content={<FlowTooltip currency={meta.currency} />} />
              </Sankey>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="uncategorized">
        <h2>Needs Categorization</h2>
        {uncategorized.length === 0 ? (
          <p>All debit transactions are categorized.</p>
        ) : (
          <ul>
            {uncategorized.slice(0, 24).map((transaction) => (
              <li key={transaction.id}>
                <strong>{transaction.date}</strong> | {transaction.merchant} | {formatCurrency(transaction.amount, meta.currency)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
