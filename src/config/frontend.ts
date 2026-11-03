export type ColorMode = "light" | "dark";

export type ThemePalette = {
  background: string;
  sidebar: string;
  surface: string;
  hover: string;
  selected: string;
  text: string;
  secondary: string;
  muted: string;
  border: string;
  strongBorder: string;
  button: string;
  buttonText: string;
  accent: string;
  danger: string;
};

export type ScenarioCategory = {
  id: string;
  label: string;
  description: string;
  tone: "coral" | "amber" | "blue" | "green";
  icon: "write" | "idea" | "code" | "chat";
  cases: Array<{ title: string; detail: string; prompt: string }>;
};

export type FrontendConfig = {
  brand: {
    name: string;
    title: string;
    description: string;
    tagline: string;
    version: string;
  };
  copy: {
    welcomeTitle: string;
    welcomeSubtitle: string;
    welcomeFootnote: string;
    composerPlaceholder: string;
    footerDisclaimer: string;
    assistantDescription: string;
    auth: {
      loginTitle: string;
      loginSubtitle: string;
      registerTitle: string;
      registerSubtitle: string;
      footer: string;
    };
    scenarios: ScenarioCategory[];
  };
  theme: {
    defaultMode: ColorMode;
    light: ThemePalette;
    dark: ThemePalette;
  };
};

const defaults: FrontendConfig = {
  brand: {
    name: "AgentCore",
    title: "AgentCore · 让想法继续",
    description: "与 AI 自然对话，让灵感、问题和想法在这里继续。",
    tagline: "让想法继续。",
    version: "1.0",
  },
  copy: {
    welcomeTitle: "有什么我可以帮你的吗？",
    welcomeSubtitle: "从一个问题开始，让想法更进一步。",
    welcomeFootnote: "一点好奇，无限可能",
    composerPlaceholder: "有问题，尽管问",
    footerDisclaimer: "AI 也会犯错，请核实重要信息。",
    assistantDescription: "你的日常 AI 助手。一起构思、创作、写代码，也可以只是聊聊。",
    auth: {
      loginTitle: "欢迎回来",
      loginSubtitle: "继续对话，让想法更进一步。",
      registerTitle: "创建你的账号",
      registerSubtitle: "从一个好问题，开始新的可能。",
      footer: "你的想法，你的空间。",
    },
    scenarios: [
      {
        id: "writing", label: "写作表达", description: "从空白草稿到清晰成文，先对齐读者、目标和语气。", tone: "coral", icon: "write",
        cases: [
          { title: "从想法开始写", detail: "通过几个关键问题，把零散想法整理成完整初稿。", prompt: "帮我把一个想法写成完整初稿。请先问我主题、目标读者、希望达成的效果和语气，再开始写。" },
          { title: "改写现有内容", detail: "保留原意，改善结构、节奏和表达。", prompt: "帮我改写一段现有内容。请先让我贴出原文，并确认读者、语气以及必须保留的信息。" },
          { title: "提炼长文摘要", detail: "区分结论、依据、行动项和待确认问题。", prompt: "帮我提炼一份长内容。请输出核心结论、关键依据、行动项和仍需确认的问题。" },
        ],
      },
      {
        id: "ideation", label: "分析创意", description: "拆解问题、比较选择，或从不同角度探索还未成形的方向。", tone: "amber", icon: "idea",
        cases: [
          { title: "一起头脑风暴", detail: "先明确边界，再给出彼此差异足够大的方向。", prompt: "我想和你一起头脑风暴。请先问清主题、限制条件和判断标准，再给出几个明显不同的方向。" },
          { title: "比较几个方案", detail: "按统一维度对照收益、成本、风险和适用条件。", prompt: "帮我比较几个方案。请先了解候选方案和我的优先级，再用统一维度给出对照和建议。" },
          { title: "把问题拆清楚", detail: "识别事实、假设、约束和真正需要决策的部分。", prompt: "帮我把一个复杂问题拆清楚。请区分事实、假设、约束、未知项和需要做出的决策。" },
        ],
      },
      {
        id: "coding", label: "开发协作", description: "从需求澄清到实现、排障和代码审查，保留验证证据。", tone: "blue", icon: "code",
        cases: [
          { title: "实现一个功能", detail: "先理解仓库和约束，再完成实现与验证。", prompt: "帮我在项目里实现一个功能。请先了解目标、现有结构和验收标准，然后修改代码并运行必要验证。" },
          { title: "诊断一个问题", detail: "从现象和证据定位原因，先给出结论再决定是否修改。", prompt: "帮我诊断一个技术问题。请检查相关代码和运行证据，说明根因、影响范围和可验证的修复方案。" },
          { title: "审查代码改动", detail: "优先寻找正确性、回归、安全和测试缺口。", prompt: "帮我审查当前代码改动。请优先检查正确性、潜在回归、安全风险和测试缺口，并给出可定位的问题说明。" },
        ],
      },
      {
        id: "conversation", label: "自由对话", description: "不预设流程，围绕一个问题持续讨论、解释或学习。", tone: "green", icon: "chat",
        cases: [
          { title: "解释一个概念", detail: "根据我的背景调整深度，并用具体例子说明。", prompt: "我想理解一个概念。请先问我目前的了解程度，再用直白解释和具体例子帮助我掌握它。" },
          { title: "制定行动计划", detail: "把目标变成有顺序、可检查的下一步。", prompt: "帮我把一个目标变成行动计划。请先确认目标、时间、资源和限制，再给出有顺序且可检查的步骤。" },
          { title: "随便聊聊", detail: "从此刻最想聊的话题开始。", prompt: "你好。先简单介绍一下你能怎样帮助我，然后问我今天想聊什么。" },
        ],
      },
    ],
  },
  theme: {
    defaultMode: "light",
    light: {
      background: "#ffffff", sidebar: "#f9f9f9", surface: "#f4f4f4", hover: "#ededed",
      selected: "#eaeaea", text: "#232323", secondary: "#747474", muted: "#929292",
      border: "#e9e9e9", strongBorder: "#dddddd", button: "#262626", buttonText: "#ffffff",
      accent: "#448976", danger: "#bc3e3e",
    },
    dark: {
      background: "#212121", sidebar: "#181818", surface: "#2f2f2f", hover: "#333333",
      selected: "#303030", text: "#ececec", secondary: "#aaaaaa", muted: "#8e8e8e",
      border: "#363636", strongBorder: "#484848", button: "#ececec", buttonText: "#202020",
      accent: "#87bfae", danger: "#f19090",
    },
  },
};

function text(value: string | undefined, fallback: string, maxLength = 160): string {
  const normalized = value?.trim();
  return normalized && normalized.length <= maxLength ? normalized : fallback;
}

function color(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && /^#[\da-f]{6}$/i.test(normalized) ? normalized : fallback;
}

function mode(value: string | undefined, fallback: ColorMode): ColorMode {
  return value === "light" || value === "dark" ? value : fallback;
}

export type FrontendEnv = {
  appName?: string;
  pageTitle?: string;
  pageDescription?: string;
  tagline?: string;
  welcomeTitle?: string;
  welcomeSubtitle?: string;
  composerPlaceholder?: string;
  defaultTheme?: string;
  lightAccent?: string;
  darkAccent?: string;
};

export function resolveFrontendConfig(env: FrontendEnv = {}): FrontendConfig {
  return {
    ...defaults,
    brand: {
      ...defaults.brand,
      name: text(env.appName, defaults.brand.name, 48),
      title: text(env.pageTitle, defaults.brand.title),
      description: text(env.pageDescription, defaults.brand.description, 240),
      tagline: text(env.tagline, defaults.brand.tagline),
    },
    copy: {
      ...defaults.copy,
      welcomeTitle: text(env.welcomeTitle, defaults.copy.welcomeTitle),
      welcomeSubtitle: text(env.welcomeSubtitle, defaults.copy.welcomeSubtitle),
      composerPlaceholder: text(env.composerPlaceholder, defaults.copy.composerPlaceholder),
    },
    theme: {
      ...defaults.theme,
      defaultMode: mode(env.defaultTheme, defaults.theme.defaultMode),
      light: { ...defaults.theme.light, accent: color(env.lightAccent, defaults.theme.light.accent) },
      dark: { ...defaults.theme.dark, accent: color(env.darkAccent, defaults.theme.dark.accent) },
    },
  };
}

export const frontendConfig = resolveFrontendConfig({
  appName: process.env.NEXT_PUBLIC_APP_NAME,
  pageTitle: process.env.NEXT_PUBLIC_PAGE_TITLE,
  pageDescription: process.env.NEXT_PUBLIC_PAGE_DESCRIPTION,
  tagline: process.env.NEXT_PUBLIC_APP_TAGLINE,
  welcomeTitle: process.env.NEXT_PUBLIC_WELCOME_TITLE,
  welcomeSubtitle: process.env.NEXT_PUBLIC_WELCOME_SUBTITLE,
  composerPlaceholder: process.env.NEXT_PUBLIC_COMPOSER_PLACEHOLDER,
  defaultTheme: process.env.NEXT_PUBLIC_DEFAULT_THEME,
  lightAccent: process.env.NEXT_PUBLIC_LIGHT_ACCENT,
  darkAccent: process.env.NEXT_PUBLIC_DARK_ACCENT,
});

const themeProperties: Array<[keyof ThemePalette, string]> = [
  ["background", "--background"], ["sidebar", "--sidebar"], ["surface", "--surface"],
  ["hover", "--hover"], ["selected", "--selected"], ["text", "--text"],
  ["secondary", "--secondary"], ["muted", "--muted"], ["border", "--border"],
  ["strongBorder", "--strong-border"], ["button", "--button"], ["buttonText", "--button-text"],
  ["accent", "--green"], ["danger", "--danger"],
];

function paletteCss(palette: ThemePalette): string {
  return themeProperties.map(([key, property]) => `${property}:${palette[key]}`).join(";");
}

export function frontendThemeCss(config: FrontendConfig = frontendConfig): string {
  return `html:root{${paletteCss(config.theme.light)}}html:root[data-theme="dark"]{${paletteCss(config.theme.dark)}}`;
}
