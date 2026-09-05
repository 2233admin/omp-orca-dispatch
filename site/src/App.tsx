import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle,
  ClipboardText,
  Code,
  GitBranch,
  GitCommit,
  GitPullRequest,
  ListChecks,
  LockKey,
  List,
  ShieldCheck,
  TerminalWindow,
  Warning,
  X,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  Code as RadixCode,
  Select,
  Separator,
  Tabs,
  Theme,
} from "@radix-ui/themes";
import i18n, { locales, setLocale, type Locale } from "./i18n";

const repositoryUrl = "https://git.xart.top/chen-qianyu/omp-orca-dispatch";
const contractExamples = {
  request: `{
  "task": "Add audit logging to the service and document the operator flow",
  "sourceRef": "ORCA-42",
  "slices": [
    {
      "name": "service",
      "task": "Implement audit events and their tests",
      "scope": ["src/audit", "tests/audit"]
    },
    {
      "name": "docs",
      "task": "Document the audit events and operator flow",
      "scope": ["docs/audit", "README.md"]
    }
  ],
  "setup": "skip",
  "agent": "omp",
  "dryRun": false
}`,
  success: `{
  "status": "dispatched",
  "baseHead": "<parent-commit>",
  "succeeded": 2,
  "failed": 0,
  "integrationRequired": true,
  "slices": [
    { "name": "service", "status": "dispatched", "scope": ["src/audit", "tests/audit"] },
    { "name": "docs", "status": "dispatched", "scope": ["docs/audit", "README.md"] }
  ]
}`,
  partial: `{
  "status": "partial",
  "baseHead": "<parent-commit>",
  "succeeded": 1,
  "failed": 1,
  "integrationRequired": true,
  "slices": [
    { "name": "service", "status": "dispatched", "scope": ["src/audit"] },
    {
      "name": "docs",
      "status": "failed",
      "scope": ["docs/audit", "README.md"],
      "possiblePartialCreate": true,
      "message": "Orca worktree create failed"
    }
  ]
}`,
} as const;

type ContractTab = keyof typeof contractExamples;

function LocaleControl() {
  const { t } = useTranslation();
  const current = (locales.includes(i18n.language as Locale) ? i18n.language : "en") as Locale;
  return (
    <label className="locale-control">
      <span className="sr-only">{t("controls.language")}</span>
      <Select.Root value={current} onValueChange={(value) => setLocale(value as Locale)}>
        <Select.Trigger aria-label={t("controls.language")} className="locale-trigger" />
        <Select.Content position="popper">
          <Select.Item value="en">EN</Select.Item>
          <Select.Item value="zh-CN">简中</Select.Item>
          <Select.Item value="ja">日本語</Select.Item>
        </Select.Content>
      </Select.Root>
    </label>
  );
}

function CopyExample({ tab }: { tab: ContractTab }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(contractExamples[tab]);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2200);
  };
  const label = state === "copied" ? t("contract.copied") : state === "failed" ? t("contract.copyFailed") : t("contract.copy");
  return (
    <>
      <Button variant="soft" size="2" onClick={() => void copy()} aria-label={label} className="copy-button">
        {state === "copied" ? <CheckCircle weight="bold" aria-hidden="true" /> : <ClipboardText aria-hidden="true" />}
        {label}
      </Button>
      <span className="copy-status sr-only" aria-live="polite" aria-atomic="true">
        {state === "idle" ? "" : label}
      </span>
    </>
  );
}

function RailVisual() {
  const { t } = useTranslation();
  const shouldReduce = useReducedMotion();
  const nodes = [
    { icon: GitCommit, label: t("hero.railParent"), tone: "orange" },
    { icon: GitBranch, label: t("hero.railWorker"), tone: "paper" },
    { icon: GitPullRequest, label: t("hero.railReview"), tone: "orange" },
  ];
  return (
    <div className="rail-visual" aria-label={t("hero.railLabel")} role="img">
      <div className="rail-kicker mono">{t("hero.railLabel")}</div>
      <div className="rail-line" aria-hidden="true" />
      <div className="rail-nodes">
        {nodes.map(({ icon: Icon, label, tone }, index) => (
          <motion.div
            className={`rail-node rail-node--${tone}`}
            key={label}
            initial={shouldReduce ? false : { opacity: 0, x: 18 }}
            animate={shouldReduce ? undefined : { opacity: 1, x: 0 }}
            transition={{ delay: index * 0.16, duration: 0.5 }}
          >
            <span className="rail-marker"><Icon weight="bold" aria-hidden="true" /></span>
            <span>{label}</span>
          </motion.div>
        ))}
      </div>
      <div className="rail-foot mono">01 / 02 / 03</div>
    </div>
  );
}

function Header() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const links = [
    ["#workflow", t("nav.how")],
    ["#contract", t("nav.contract")],
    ["#safety", t("nav.safety")],
    ["#install", t("nav.install")],
  ];
  return (
    <header className="site-header">
      <a className="skip-link" href="#main-content">{t("controls.skip")}</a>
      <div className="header-inner">
        <a className="brand" href="#top" aria-label={t("controls.home")}>
          <span className="brand-mark">O</span>
          <span className="brand-word">OMP<span>/</span>ORCA</span>
        </a>
        <button className="mobile-menu" type="button" aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen((value) => !value)}>
          {open ? <X size={20} aria-hidden="true" /> : <List size={20} aria-hidden="true" />}
          <span className="sr-only">{open ? t("controls.close") : t("controls.menu")}</span>
        </button>
        <nav id="site-navigation" className={`site-nav ${open ? "is-open" : ""}`} aria-label={t("controls.navigation")} onClick={() => setOpen(false)}>
          {links.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
          <a className="nav-source" href={repositoryUrl} target="_blank" rel="noreferrer">{t("nav.open")} <ArrowUpRight aria-hidden="true" /></a>
          <LocaleControl />
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  const { t } = useTranslation();
  const shouldReduce = useReducedMotion();
  return (
    <section className="hero section-grid" id="top">
      <motion.div className="hero-copy" initial={shouldReduce ? false : { opacity: 0, y: 16 }} animate={shouldReduce ? undefined : { opacity: 1, y: 0 }} transition={{ duration: 0.55 }}>
        <div className="eyebrow"><span className="signal-dot" />{t("hero.eyebrow")}</div>
        <h1 className="hero-title"><span className="hero-title-line">{t("hero.titleLine1")}</span><span className="hero-title-line">{t("hero.titleLine2")}</span></h1>
        <p className="hero-body">{t("hero.body")}</p>
        <div className="hero-actions">
          <Button asChild size="3" className="button-orange"><a href="#contract">{t("hero.cta")} <ArrowDownRight weight="bold" aria-hidden="true" /></a></Button>
          <Button asChild variant="outline" size="3"><a href={repositoryUrl} target="_blank" rel="noreferrer">{t("hero.source")} <ArrowUpRight aria-hidden="true" /></a></Button>
        </div>
      </motion.div>
      <RailVisual />
      <div className="hero-stamp mono">{t("hero.stampTitle")}<br />{t("hero.stampRail")}<br /><span>{t("hero.stampVersion")}</span></div>
    </section>
  );
}

function FactStrip() {
  const { t } = useTranslation();
  const facts = [
      ["02–03", t("facts.slices")],
    ["HEAD", t("facts.head")],
    ["ORDER", t("facts.output")],
    ["NO", t("facts.merge")],
  ];
  return <div className="fact-strip" aria-label={t("controls.facts")}>{facts.map(([value, label]) => <div className="fact" key={label}><strong className="mono">{value}</strong><span>{label}</span></div>)}</div>;
}

function Workflow() {
  const { t } = useTranslation();
  const steps = [t("workflow.define", { returnObjects: true }) as { number: string; title: string; body: string }, t("workflow.dispatch", { returnObjects: true }) as { number: string; title: string; body: string }, t("workflow.review", { returnObjects: true }) as { number: string; title: string; body: string }];
  return (
    <section className="section section-paper" id="workflow">
      <div className="section-heading">
        <div className="eyebrow">{t("workflow.eyebrow")}</div>
        <h2><span className="section-title-line">{t("workflow.titleLine1")}</span><span className="section-title-line">{t("workflow.titleLine2")}</span></h2>
        <p>{t("workflow.body")}</p>
      </div>
      <div className="workflow-grid">
        {steps.map((step) => <article className="workflow-card" key={step.number}><span className="step-number mono">{step.number}</span><h3>{step.title}</h3><p>{step.body}</p><ArrowDownRight className="workflow-arrow" aria-hidden="true" /></article>)}
      </div>
    </section>
  );
}

function Contract() {
  const { t } = useTranslation();
  const tabs = ["request", "success", "partial"] as const;
  const labels = { request: t("contract.tabs.request"), success: t("contract.tabs.success"), partial: t("contract.tabs.partial") };
  const headings = { request: t("contract.requestLabel"), success: t("contract.successLabel"), partial: t("contract.partialLabel") };
  return (
    <section className="section contract-section" id="contract">
      <div className="section-heading section-heading--split"><div><div className="eyebrow">{t("contract.eyebrow")}</div><h2>{t("contract.title")}</h2></div><p>{t("contract.body")}</p></div>
      <Tabs.Root defaultValue="request" className="contract-tabs">
        <Tabs.List aria-label={t("contract.eyebrow")} className="contract-tab-list">{tabs.map((tab) => <Tabs.Trigger key={tab} value={tab}>{labels[tab]}</Tabs.Trigger>)}</Tabs.List>
        {tabs.map((tab) => <Tabs.Content key={tab} value={tab} className="contract-panel"><div className="code-head"><span className="mono">{headings[tab]}</span><CopyExample tab={tab} /></div><pre><code>{contractExamples[tab]}</code></pre></Tabs.Content>)}
      </Tabs.Root>
    </section>
  );
}

function Suitable() {
  const { t } = useTranslation();
  return (
    <section className="section suitable-section">
      <div className="section-heading"><div className="eyebrow">{t("suitable.eyebrow")}</div><h2><span className="section-title-line">{t("suitable.titleLine1")}</span><span className="section-title-line">{t("suitable.titleLine2")}</span></h2></div>
      <div className="suitable-grid">
        <Card className="fit-card fit-card--good">
          <div className="fit-icon"><CheckCircle weight="bold" aria-hidden="true" /></div>
          <span className="mono fit-label">{t("suitable.goodLabel")}</span>
          <h3>{t("suitable.goodTitle")}</h3>
          <p>{t("suitable.goodBody")}</p>
        </Card>
        <Card className="fit-card fit-card--keep">
          <div className="fit-icon"><LockKey weight="bold" aria-hidden="true" /></div>
          <span className="mono fit-label">{t("suitable.keepLabel")}</span>
          <h3>{t("suitable.keepTitle")}</h3>
          <p>{t("suitable.keepBody")}</p>
        </Card>
      </div>
      <p className="scope-note"><ListChecks weight="bold" aria-hidden="true" />{t("suitable.note")}</p>
    </section>
  );
}

function Interfaces() {
  const { t } = useTranslation();
  const items = [
    { key: "pi", icon: Code, data: t("interfaces.pi", { returnObjects: true }) as { name: string; detail: string; body: string } },
    { key: "omp", icon: TerminalWindow, data: t("interfaces.omp", { returnObjects: true }) as { name: string; detail: string; body: string } },
  ];
  return (
    <section className="section interfaces-section">
      <div className="section-heading section-heading--split"><div><div className="eyebrow">{t("interfaces.eyebrow")}</div><h2>{t("interfaces.title")}</h2></div><p>{t("interfaces.body")}</p></div>
      <div className="interfaces-grid">{items.map(({ key, icon: Icon, data }, index) => <article className="interface-card" key={key}><div className="interface-top"><span className="interface-index mono">0{index + 1}</span><Icon size={28} weight="duotone" aria-hidden="true" /></div><h3>{data.name}</h3><RadixCode variant="soft">{data.detail}</RadixCode><p>{data.body}</p></article>)}</div>
    </section>
  );
}

function Safety() {
  const { t } = useTranslation();
  const rows = t("safety.rows", { returnObjects: true }) as Array<[string, string, string]>;
  return (
    <section className="section safety-section" id="safety">
      <div className="section-heading section-heading--split"><div><div className="eyebrow"><ShieldCheck weight="bold" aria-hidden="true" /> {t("safety.eyebrow")}</div><h2>{t("safety.title")}</h2></div><p>{t("safety.body")}</p></div>
      <div className="safety-list">{rows.map(([number, title, body]) => <motion.div className="safety-row" key={number} initial={false} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.3 }} transition={{ duration: 0.32 }}><span className="mono safety-number">{number}</span><LockKey className="safety-icon" weight="duotone" aria-hidden="true" /><h3>{title}</h3><p>{body}</p></motion.div>)}</div>
    </section>
  );
}

function Install() {
  const { t } = useTranslation();
  return (
    <section className="section install-section" id="install">
      <div className="section-heading"><div className="eyebrow">{t("install.eyebrow")}</div><h2>{t("install.title")}</h2><p>{t("install.body")}</p></div>
      <div className="install-grid">
        <Card className="install-card"><div className="card-kicker mono">{t("install.checkout")}</div><pre><code>{`git clone https://git.xart.top/chen-qianyu/omp-orca-dispatch\ncd omp-orca-dispatch\nnpm ci\nnpm run build\nnode bin/orca-task-dispatch.mjs doctor --host omp --json`}</code></pre><p>{t("install.runDoctor")}</p></Card>
        <Card className="release-card"><div className="card-kicker mono">{t("install.release")}</div><p>{t("install.releaseBody")}</p><div className="release-line"><GitBranch weight="bold" aria-hidden="true" /><span>{t("install.requirements")}</span></div><Separator size="4" /><div className="card-kicker mono">{t("install.backend")}</div><p>{t("install.backendBody")}</p></Card>
      </div>
    </section>
  );
}

function Footer() {
  const { t } = useTranslation();
  return <footer className="site-footer"><div><span className="brand-word">OMP<span>/</span>ORCA</span><p>{t("footer.line")}</p></div><div className="footer-links"><a href={repositoryUrl} target="_blank" rel="noreferrer">{t("footer.source")} <ArrowUpRight aria-hidden="true" /></a><a href={`${repositoryUrl}/src/branch/main/docs/upstream-integration.md`} target="_blank" rel="noreferrer">{t("footer.docs")} <ArrowUpRight aria-hidden="true" /></a><a href={`${repositoryUrl}/src/branch/main/SECURITY.md`} target="_blank" rel="noreferrer">{t("footer.security")} <ArrowUpRight aria-hidden="true" /></a><span className="mono">{t("footer.license")}</span></div></footer>;
}

export default function App() {
  const { t } = useTranslation();
  const shouldReduce = useReducedMotion();
  const pageTitle = useMemo(() => t("meta.title"), [t]);
  useEffect(() => { document.title = pageTitle; }, [pageTitle]);
  return <Theme appearance="dark" accentColor="orange" grayColor="sand" radius="none"><div className="app-shell"><Header /><main id="main-content" tabIndex={-1}><Hero /><FactStrip /><Workflow /><Contract /><Suitable /><Interfaces /><Safety /><Install /></main><Footer /></div>{shouldReduce ? null : <div className="grain" aria-hidden="true" />}</Theme>;
}
