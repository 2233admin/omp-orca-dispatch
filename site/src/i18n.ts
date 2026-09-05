import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export const locales = ["en", "zh-CN", "ja"] as const;
export type Locale = (typeof locales)[number];
const storageKey = "omp-orca-dispatch-locale";

const resources = {
  en: {
    translation: {
      meta: { title: "omp-orca-dispatch – Dispatch Rail", description: "Bounded, disjoint Orca worktree dispatch for Pi and Oh My Pi." },
      nav: { how: "How it works", contract: "Contract", safety: "Safety", install: "Install", open: "Open source" },
      controls: { language: "Language", menu: "Open navigation", close: "Close navigation", skip: "Skip to content", home: "omp-orca-dispatch home", navigation: "Primary navigation", facts: "Project facts" },
      hero: {
        eyebrow: "ORCA DISPATCH / PI + OMP",
        titleLine1: "Split work.", titleLine2: "Keep ownership.",
        body: "A host extension that starts from a committed parent HEAD and dispatches two or three independent Orca worktrees. Each worker gets a literal scope. The parent keeps the review and integration decision.",
        cta: "See the contract",
        source: "View repository",
        railLabel: "DISPATCH RAIL",
        railParent: "PARENT / EXACT HEAD",
        railWorker: "WORKER / EXCLUSIVE SCOPE",
        railReview: "CALLER / REVIEW + INTEGRATE",
        stampTitle: "DISPATCH", stampRail: "RAIL", stampVersion: "v0.1 / ORCA"
      },
      facts: {
        slices: "2–3 slices",
        head: "One exact HEAD",
        output: "Ordered results",
        merge: "No auto-merge"
      },
      workflow: {
        eyebrow: "THE LOOP",
        titleLine1: "One request.", titleLine2: "Three clear handoffs.",
        body: "The tool is deliberately narrow: validate the boundary, create the children, return the state. Work continues in Orca; integration stays with the caller.",
        define: { number: "01", title: "Define", body: "Name the parent task, then give each slice a self-contained task and exclusive repository-relative literal paths." },
        dispatch: { number: "02", title: "Dispatch", body: "The extension checks Orca, reads the current committed HEAD, and creates sibling worktrees concurrently from that same HEAD." },
        review: { number: "03", title: "Review", body: "Workers are instructed to check, commit, and report evidence. The parent reviews the child work and chooses how to integrate it." }
      },
      contract: {
        eyebrow: "STATIC CONTRACT / NON-EXECUTING EXAMPLES",
        title: "The shape is visible before the command runs.",
        body: "These panels show the public request and result envelopes. They are documentation examples, not runnable controls.",
        tabs: { request: "Request", success: "Dispatched", partial: "Partial" },
        copy: "Copy example", copied: "Copied", copyFailed: "Copy unavailable",
        requestLabel: "TWO-SLICE REQUEST",
        successLabel: "SUCCESS ENVELOPE",
        partialLabel: "PARTIAL ENVELOPE"
      },
      suitable: {
        eyebrow: "SCOPE TEST",
        titleLine1: "Use it for separated work.", titleLine2: "Keep coupled work together.",
        goodTitle: "A good fit",
        goodBody: "A feature with independent implementation areas, such as service code and its documentation, can be split into exclusive paths.",
        keepTitle: "Keep it together",
        keepBody: "Changes that touch the same files, depend on one another's uncommitted edits, or need one ordered migration belong in one task.",
        note: "The dispatcher accepts exactly two or three slices. It rejects equal and parent/child scope overlap.",
        goodLabel: "GOOD FIT", keepLabel: "KEEP TOGETHER"
      },
      interfaces: {
        eyebrow: "TWO HOSTS / ONE TOOL",
        title: "Native at the edge, shared in the middle.",
        body: "Pi and Oh My Pi get their own schema adapter. Both register the same dispatcher and send work through the Orca CLI.",
        pi: { name: "Pi", detail: "TypeBox parameters", body: "The Pi entrypoint registers the shared dispatcher with Pi-compatible TypeBox metadata." },
        omp: { name: "Oh My Pi", detail: "Injected Zod parameters", body: "The OMP entrypoint uses the host's injected Zod builder and requests write approval with essential loading." }
      },
      safety: {
        eyebrow: "BOUNDARIES",
        title: "Refuse ambiguity before it becomes shared state.",
        body: "The safety model is enforced in the dispatcher and worker prompt, not left to a convention in the example.",
        rows: [
          ["01", "Literal scopes", "Repository-relative paths only. No globs, traversal, root ownership, .git, reserved names, controls, or overlap."],
          ["02", "Exact starting point", "Every Orca create receives the same current committed HEAD and parent worktree ID."],
          ["03", "Argument boundary", "Commands use executable-plus-argv values. Task text, paths, IDs, and prompts are not shell fragments."],
          ["04", "Untrusted source", "sourceRef is an opaque label. It is not fetched, parsed, authenticated, or used to mutate a tracker."],
          ["05", "Failure state", "Results stay ordered, isolate per-slice failures, flag possible partial creation, and redact URL credentials."]
        ] as Array<[string, string, string]>
      },
      install: {
        eyebrow: "RELEASE STATUS",
        title: "Build from checkout. Verify before you connect a host.",
        body: "The public npm package is not currently available. The checkout path builds the project and diagnoses a selected host and Orca; it does not install an unpublished package.",
        checkout: "CHECKOUT VERIFICATION",
        release: "NPM PUBLICATION",
        releaseBody: "Version 0.1.0 is in package.json. Publication is blocked by ENEEDAUTH, so npx installation is not presented as a working path.",
        backend: "BACKEND STATUS",
        backendBody: "The shipped dispatcher is Orca-only. No alternate backend selector is exposed.",
        requirements: "Node ≥22.19 · Pi ≥0.84.4 · OMP ≥18.1.8 · Orca ≥1.4.195",
        runDoctor: "Run doctor for Pi with --host pi."
      },
      footer: {
        line: "A small dispatch boundary for agents that need separate worktrees, not a merge service.",
        source: "Source",
        docs: "Docs",
        security: "Security",
        license: "Apache-2.0"
      }
    }
  },
  "zh-CN": {
    translation: {
      meta: { title: "omp-orca-dispatch – Dispatch Rail", description: "面向 Pi 与 Oh My Pi 的有界、互不重叠 Orca 工作树分派。" },
      nav: { how: "工作方式", contract: "契约", safety: "边界", install: "安装", open: "开源仓库" },
      controls: { language: "语言", menu: "打开导航", close: "关闭导航", skip: "跳到主要内容", home: "omp-orca-dispatch 首页", navigation: "主导航", facts: "项目事实" },
      hero: {
        eyebrow: "ORCA 分派 / PI + OMP",
        titleLine1: "拆开工作，", titleLine2: "保留所有权。",
        body: "一个主机扩展，从父工作树已提交的 HEAD 开始，分派两个或三个独立的 Orca 工作树。每个工作者获得明确且互斥的路径范围，由父任务所在的调用方负责审查与决定如何集成。",
        cta: "查看契约",
        source: "查看仓库",
        railLabel: "分派轨道",
        railParent: "父工作树 / 精确 HEAD",
        railWorker: "工作者 / 独占范围",
        railReview: "调用方 / 审查 + 集成",
        stampTitle: "分派", stampRail: "轨道", stampVersion: "v0.1 / ORCA"
      },
      facts: { slices: "2–3 个切片", head: "一个精确 HEAD", output: "有序结果", merge: "不自动合并" },
      workflow: {
        eyebrow: "工作循环",
        titleLine1: "一个请求，", titleLine2: "三次清晰交接。",
        body: "工具刻意保持狭窄：验证边界、创建子工作树、返回状态。工作在 Orca 中继续，集成仍由调用方负责。",
        define: { number: "01", title: "定义", body: "写清父任务，再为每个切片提供自包含任务和互斥的仓库相对字面路径。" },
        dispatch: { number: "02", title: "分派", body: "扩展检查 Orca，读取当前已提交 HEAD，再从同一个 HEAD 并发创建兄弟工作树。" },
        review: { number: "03", title: "审查", body: "工作者会被要求检查、提交并报告证据。父调用方审查子工作，并决定如何集成。" }
      },
      contract: {
        eyebrow: "静态契约 / 不执行示例",
        title: "命令运行前，先看清数据形状。",
        body: "这些面板展示公开的请求和结果封装。它们是文档示例，不是可执行控制。",
        tabs: { request: "请求", success: "已分派", partial: "部分成功" },
        copy: "复制示例", copied: "已复制", copyFailed: "无法复制",
        requestLabel: "双切片请求", successLabel: "成功封装", partialLabel: "部分封装"
      },
      suitable: {
        eyebrow: "范围测试",
        titleLine1: "适合分离的工作。", titleLine2: "耦合的工作放在一起。",
        goodTitle: "适合场景",
        goodBody: "如果功能有独立的实现区域，例如服务代码和对应文档，可以按互斥路径拆分。",
        keepTitle: "保持一起",
        keepBody: "会触及同一文件、依赖另一方未提交修改，或需要单一迁移顺序的变更，应放在一个任务中。",
        note: "分派器只接受两个或三个切片，并拒绝相等范围以及父子范围重叠。",
        goodLabel: "适合场景", keepLabel: "保持一起"
      },
      interfaces: {
        eyebrow: "两个主机 / 一个工具",
        title: "边缘原生，中间共享。",
        body: "Pi 和 Oh My Pi 各自使用对应的参数适配器，但注册同一个分派器，并通过 Orca CLI 发送工作。",
        pi: { name: "Pi", detail: "TypeBox 参数", body: "Pi 入口使用 Pi 兼容的 TypeBox 元数据注册共享分派器。" },
        omp: { name: "Oh My Pi", detail: "注入式 Zod 参数", body: "OMP 入口使用主机注入的 Zod 构建器，并请求写入批准和 essential 加载。" }
      },
      safety: {
        eyebrow: "边界",
        title: "在歧义变成共享状态前拒绝它。",
        body: "安全模型由分派器和工作者提示词执行，而不是依赖示例中的约定。",
        rows: [
          ["01", "字面范围", "只接受仓库相对路径。不接受 glob、遍历、根目录、.git、保留名称、控制字符或重叠。"],
          ["02", "精确起点", "每次 Orca 创建都收到同一个当前已提交 HEAD 和父工作树 ID。"],
          ["03", "参数边界", "命令使用 executable + argv。任务文本、路径、ID 和提示词不会成为 shell 片段。"],
          ["04", "不可信来源", "sourceRef 只是透明标签，不会被获取、解析、认证，也不会用于修改 tracker。"],
          ["05", "失败状态", "结果保持有序，隔离每个切片的失败，标记可能的部分创建，并遮蔽 URL 凭据。"]
        ] as Array<[string, string, string]>
      },
      install: { eyebrow: "发布状态",
        title: "从签出构建，在连接主机前先诊断。",
        body: "公共 npm 包目前不可用。可以从签出构建项目，并诊断选定的主机与 Orca；不会安装尚未发布的包。",
        checkout: "签出验证", release: "npm 发布",
        releaseBody: "package.json 中的版本是 0.1.0。发布被 ENEEDAUTH 阻塞，因此不会把 npx 安装写成可用路径。",
        backend: "后端状态", backendBody: "已交付的分派器仅支持 Orca，没有暴露其他后端选择器。",
        requirements: "Node ≥22.19 · Pi ≥0.84.4 · OMP ≥18.1.8 · Orca ≥1.4.195",
        runDoctor: "Pi 请使用 --host pi 运行 doctor。"
      },
      footer: { line: "为需要独立工作树的代理提供小而清晰的分派边界，不是合并服务。", source: "源码", docs: "文档", security: "安全", license: "Apache-2.0" }
    }
  },
  ja: {
    translation: {
      meta: { title: "omp-orca-dispatch – Dispatch Rail", description: "Pi と Oh My Pi のための、範囲を限定した Orca worktree 分配。" },
      nav: { how: "仕組み", contract: "契約", safety: "安全境界", install: "導入", open: "ソース" },
      controls: { language: "言語", menu: "ナビゲーションを開く", close: "ナビゲーションを閉じる", skip: "メインコンテンツへ移動", home: "omp-orca-dispatch ホーム", navigation: "メインナビゲーション", facts: "プロジェクトの要点" },
      hero: {
        eyebrow: "ORCA DISPATCH / PI + OMP",
        titleLine1: "仕事を分け、", titleLine2: "所有権を残す。",
        body: "コミット済みの親 HEAD から、2 つまたは 3 つの独立した Orca worktree を作るホスト拡張です。各 worker には明確な専有範囲を渡し、親側の呼び出し元がレビューと統合を判断します。",
        cta: "契約を見る", source: "リポジトリを見る",
        railLabel: "分派レール", railParent: "親 / 正確な HEAD", railWorker: "作業者 / 専有範囲", railReview: "呼び出し元 / レビュー + 統合",
        stampTitle: "分派", stampRail: "レール", stampVersion: "v0.1 / ORCA"
      },
      facts: { slices: "2–3 スライス", head: "ひとつの正確な HEAD", output: "順序付き結果", merge: "自動マージなし" },
      workflow: {
        eyebrow: "ワークフロー",
        titleLine1: "ひとつのリクエスト。", titleLine2: "3 つの明確な引き渡し。",
        body: "このツールは意図的に狭い設計です。境界を検証し、子 worktree を作り、状態を返します。作業は Orca で続き、統合は呼び出し元が担当します。",
        define: { number: "01", title: "定義", body: "親タスクをまとめ、各スライスに自己完結したタスクと専有するリポジトリ相対のリテラルパスを与えます。" },
        dispatch: { number: "02", title: "分派", body: "拡張が Orca の準備状態を確認し、現在のコミット済み HEAD を読み、同じ HEAD から兄弟 worktree を並行作成します。" },
        review: { number: "03", title: "レビュー", body: "worker には検証、コミット、証拠の報告を指示します。親が子の変更をレビューし、統合方法を決めます。" }
      },
      contract: {
        eyebrow: "静的な契約 / 実行しない例",
        title: "コマンド実行前に、形を確認する。",
        body: "公開リクエストと結果のレスポンスを示します。実行ボタンではなく、ドキュメント用の例です。",
        tabs: { request: "リクエスト", success: "分派済み", partial: "部分成功" },
        copy: "例をコピー", copied: "コピー済み", copyFailed: "コピーできません",
        requestLabel: "2 スライスのリクエスト", successLabel: "成功レスポンス", partialLabel: "部分レスポンス"
      },
      suitable: {
        eyebrow: "範囲テスト",
        titleLine1: "分離できる仕事に使う。", titleLine2: "結合した仕事は分けない。",
        goodTitle: "向いているもの",
        goodBody: "サービスのコードとドキュメントのように、実装領域が独立している変更は専有パスに分けられます。",
        keepTitle: "まとめて扱うもの",
        keepBody: "同じファイルを触る変更、未コミットの編集に依存する変更、順序が必要な移行はひとつのタスクにします。",
        note: "分派器は 2 つまたは 3 つのスライスだけを受け付け、同一範囲と親子範囲の重複を拒否します。",
        goodLabel: "向いているもの", keepLabel: "まとめて扱う"
      },
      interfaces: {
        eyebrow: "2 ホスト / 1 ツール",
        title: "端はネイティブに、中央は共有で。",
        body: "Pi と Oh My Pi はそれぞれのスキーマアダプターを持ちます。共通の分派器を登録し、Orca CLI に作業を渡します。",
        pi: { name: "Pi", detail: "TypeBox パラメーター", body: "Pi のエントリポイントは、Pi 対応の TypeBox メタデータで共通分派器を登録します。" },
        omp: { name: "Oh My Pi", detail: "注入された Zod パラメーター", body: "OMP のエントリポイントは、ホストから注入された Zod ビルダーを使い、書き込み許可と essential load メタデータを設定します。" }
      },
      safety: {
        eyebrow: "境界",
        title: "曖昧さが共有状態になる前に止める。",
        body: "安全境界は例の作法ではなく、分派器と worker prompt が実行します。",
        rows: [
          ["01", "リテラル範囲", "リポジトリ相対パスだけを許可します。glob、traversal、root、.git、予約名、制御文字、重複は拒否します。"],
          ["02", "正確な起点", "すべての Orca create に同じコミット済み HEAD と親 worktree ID を渡します。"],
          ["03", "引数の境界", "コマンドは executable と argv で渡します。task、path、ID、prompt は shell fragment になりません。"],
          ["04", "信頼しない参照", "sourceRef はそのまま扱うラベルです。取得・解析・認証や tracker の変更には使いません。"],
          ["05", "失敗状態", "結果の順序を保ち、スライスごとの失敗、部分作成の可能性、URL 資格情報の伏字を返します。"]
        ] as Array<[string, string, string]>
      },
      install: {
        eyebrow: "リリース状況",
        title: "checkout からビルドし、ホスト接続前に検証する。",
        body: "公開 npm パッケージは現在利用できません。checkout からプロジェクトをビルドし、選択したホストと Orca の状態を doctor で確認できますが、未公開パッケージはインストールしません。",
        checkout: "checkout の検証", release: "npm 公開",
        releaseBody: "package.json のバージョンは 0.1.0。公開は ENEEDAUTH で停止しているため、npx インストールを利用可能な手順として示しません。",
        backend: "バックエンドの状態", backendBody: "提供中の分派器は Orca のみを扱い、別のバックエンド選択肢はありません。",
        requirements: "Node ≥22.19 · Pi ≥0.84.4 · OMP ≥18.1.8 · Orca ≥1.4.195",
        runDoctor: "Pi では --host pi を付けて doctor を実行します。"
      },
      footer: {
        line: "独立した worktree が必要なエージェント向けの、小さな分派境界です。マージサービスではありません。",
        source: "ソース", docs: "ドキュメント", security: "セキュリティ", license: "Apache-2.0"
      }
    }
  }
} as const;

function validLocale(value: string | null): Locale | undefined {
  return locales.find((locale) => locale === value);
}

function detectLocale(): Locale {
  const queryLocale = new URLSearchParams(window.location.search).get("lang");
  const fromQuery = validLocale(queryLocale);
  if (fromQuery) return fromQuery;
  try {
    const fromStorage = validLocale(window.localStorage.getItem(storageKey));
    if (fromStorage) return fromStorage;
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
  const language = navigator.language.toLowerCase();
  if (language.startsWith("zh")) return "zh-CN";
  if (language.startsWith("ja")) return "ja";
  return "en";
}

export function setLocale(locale: Locale): void {
  void i18n.changeLanguage(locale);
  const url = new URL(window.location.href);
  url.searchParams.set("lang", locale);
  window.history.replaceState({}, "", url);
  try {
    window.localStorage.setItem(storageKey, locale);
  } catch {
    // Preference still applies for the current page.
  }
  syncDocumentMeta(locale);
}

export function syncDocumentMeta(locale: Locale): void {
  const translate = i18n.getFixedT(locale);
  document.documentElement.lang = locale;
  document.title = translate("meta.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", translate("meta.description"));
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectLocale(),
  fallbackLng: "en",
  interpolation: { escapeValue: false }
}).then(() => {
  syncDocumentMeta(i18n.language as Locale);
});

i18n.on("languageChanged", (locale) => syncDocumentMeta(locale as Locale));

export default i18n;
