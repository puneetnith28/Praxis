import type { TourStepConfig } from './tourTypes';

export const TOUR_STEPS: TourStepConfig[] = [
  // ============================================================
  // PHASE 1: Explore the Platform (Main Page / Landing Overview)
  // ============================================================
  {
    id: 'landing_hero',
    stepNumber: 1,
    phase: 1,
    phaseTitle: 'Platform Overview',
    targetSelector: '[data-tour="landing-hero"]',
    fallbackSelector: '.hero-center-content, .landing-hero',
    title: 'The Multi-Agent Control Center',
    subtitle: 'Unified AI Engineering',
    description:
      'Bedrock gives engineers one cohesive environment to run Claude Code, Codex, Gemini, OpenCode, and local models.',
    tooltipText:
      'Coordinate multiple autonomous AI coding agents working side-by-side on your real codebases.',
    preferredPlacement: 'bottom',
    requiredView: 'landing',
  },
  {
    id: 'landing_demo',
    stepNumber: 2,
    phase: 1,
    phaseTitle: 'Platform Overview',
    targetSelector: '[data-tour="landing-demo"]',
    fallbackSelector: '.demo-showcase-section, .conduit-cinematic-stage',
    title: 'Coordinated Agent Workflows',
    subtitle: 'Autonomous Execution',
    description:
      'Watch how Bedrock orchestrates prompts, decomposes tasks into plans, and runs multiple agents simultaneously.',
    tooltipText:
      'Observe real terminal shells where Claude refactors code while Codex runs integration tests.',
    preferredPlacement: 'bottom',
    requiredView: 'landing',
  },
  {
    id: 'landing_safety',
    stepNumber: 3,
    phase: 1,
    phaseTitle: 'Platform Overview',
    targetSelector: '#how-it-works',
    fallbackSelector: '.how-it-works-sec',
    title: 'Human-in-the-Loop Safety',
    subtitle: 'Safety Loop & Approval Gates',
    description:
      'Every agent output is classified in real time. Dangerous commands like force pushes or drop tables are intercepted before execution.',
    tooltipText:
      'Nothing consequential reaches the terminal without your explicit human approval.',
    preferredPlacement: 'top',
    requiredView: 'landing',
  },
  {
    id: 'landing_ecosystem',
    stepNumber: 4,
    phase: 1,
    phaseTitle: 'Platform Overview',
    targetSelector: '#ecosystem',
    fallbackSelector: '.tool-ecosystem-section',
    title: 'Works With Your Tools',
    subtitle: 'Broad Ecosystem Compatibility',
    description:
      'Native integration with Claude Code, OpenAI Codex, Gemini CLI, Amazon Bedrock, xterm.js, and node-pty.',
    tooltipText:
      'Bring the models and command-line tools you already use directly into your Bedrock workflow.',
    preferredPlacement: 'top',
    requiredView: 'landing',
  },
  {
    id: 'landing_features',
    stepNumber: 5,
    phase: 1,
    phaseTitle: 'Platform Overview',
    targetSelector: '#features',
    fallbackSelector: '.workflow-showcase-container',
    title: 'Core Workflow Capabilities',
    subtitle: 'Engineered for Control',
    description:
      'From 5 persistent window layouts to universal Group Chat and MCP messaging, Bedrock gives you total workspace supervision.',
    tooltipText:
      'Explore live terminals, multi-split layouts, inter-agent messaging, and voice commands.',
    preferredPlacement: 'top',
    requiredView: 'landing',
  },

  // ============================================================
  // PHASE 2: Inside the Live Control Center (Interactive Workspace)
  // ============================================================
  {
    id: 'workspace',
    stepNumber: 6,
    phase: 2,
    phaseTitle: 'Inside Control Center',
    targetSelector: '[data-tour="workspace"]',
    fallbackSelector: '.breadcrumb, .sb-projects, .header-l',
    title: 'Start with your workspace',
    subtitle: 'Where your work lives',
    description: 'Projects, agents, and engineering work stay organized in one place.',
    tooltipText: 'Your repositories, branches, and active agents stay organized in one unified studio.',
    preferredPlacement: 'bottom',
    requiredView: 'console',
    requiredTab: 'terminals',
  },
  {
    id: 'agents',
    stepNumber: 7,
    phase: 2,
    phaseTitle: 'Inside Control Center',
    targetSelector: '[data-tour="agents"]',
    fallbackSelector: '.agent-grid, .gr, .sb-agents-wrap',
    title: 'Run multiple coding agents',
    subtitle: 'Who is working',
    description:
      'Claude Code, Codex, Gemini CLI, and OpenCode can work side-by-side from the same control center.',
    tooltipText:
      'Keep multiple AI coding agents working side-by-side while you supervise the whole workspace.',
    preferredPlacement: 'right',
    requiredView: 'console',
    requiredTab: 'terminals',
  },
  {
    id: 'terminal',
    stepNumber: 8,
    phase: 2,
    phaseTitle: 'Inside Control Center',
    targetSelector: '[data-tour="terminal"]',
    fallbackSelector: '.term-wrap, .agent-terminal, .terminal-container',
    title: 'Watch the real work happen',
    subtitle: 'Real interactive terminals',
    description:
      'Agents work in real terminals, so you can see commands, output, tests, and progress as they happen.',
    tooltipText:
      'See what your agents are actually doing instead of relying on abstract progress indicators.',
    preferredPlacement: 'top',
    requiredView: 'console',
    requiredTab: 'terminals',
  },
  {
    id: 'approval_gate',
    stepNumber: 9,
    phase: 2,
    phaseTitle: 'Inside Control Center',
    targetSelector: '[data-tour="approval-gate"]',
    fallbackSelector: '.tour-gate-modal, .modal-gate',
    title: 'Risky actions stop here',
    subtitle: 'Human approval gate',
    description:
      'Bedrock can intercept dangerous or consequential commands and wait for your approval.',
    tooltipText:
      'Bedrock keeps consequential actions behind an explicit human decision. Click Approve to proceed!',
    preferredPlacement: 'top',
    requiresHumanApproval: true,
    requiredView: 'console',
    requiredTab: 'terminals',
  },
  {
    id: 'supervisor',
    stepNumber: 10,
    phase: 2,
    phaseTitle: 'Inside Control Center',
    targetSelector: '[data-tour="supervisor"]',
    fallbackSelector: '.supervisor-telemetry, .st-l, .header-r',
    title: 'One layer keeps watch',
    subtitle: 'Continuous supervision',
    description:
      'The Supervisor continuously watches agent output for blockers, questions, and risky actions.',
    tooltipText:
      'Bedrock watches your agents while they work and surfaces things that need your attention.',
    preferredPlacement: 'bottom',
    requiredView: 'console',
    requiredTab: 'terminals',
  },
  {
    id: 'group_chat',
    stepNumber: 11,
    phase: 2,
    phaseTitle: 'Inside Control Center',
    targetSelector: '[data-tour="groupchat"]',
    fallbackSelector: '.gc-panel, .panel, .gr-tabs button:nth-child(3)',
    title: 'Let agents collaborate',
    subtitle: 'Universal team chat',
    description:
      'Coordinate agents from one shared conversation without losing context.',
    tooltipText:
      'Give agents and humans a shared place to exchange context and coordinate work.',
    preferredPlacement: 'right',
    requiredView: 'console',
    requiredTab: 'groupchat',
  },
  {
    id: 'mcp_messaging',
    stepNumber: 12,
    phase: 2,
    phaseTitle: 'Inside Control Center',
    targetSelector: '[data-tour="mcp"]',
    fallbackSelector: '.messages-panel, .panel, .gr-tabs button:nth-child(2)',
    title: 'Move context between agents',
    subtitle: 'MCP inter-agent messaging',
    description:
      'Use Bedrock\'s inter-agent messaging layer to pass useful context between coding agents.',
    tooltipText:
      'Let agents exchange useful context without forcing everything through the human.',
    preferredPlacement: 'right',
    requiredView: 'console',
    requiredTab: 'messages',
  },
  {
    id: 'keeper_command',
    stepNumber: 13,
    phase: 2,
    phaseTitle: 'Inside Control Center',
    targetSelector: '[data-tour="keeper"]',
    fallbackSelector: '.cmd-quick, .header-r',
    title: 'Stay in control from one place',
    subtitle: 'Command your workspace',
    description:
      'Use the command interface and Keeper to inspect and control your workspace without losing context.',
    tooltipText:
      'Use Bedrock\'s command controls to inspect activity and take action when you need to.',
    preferredPlacement: 'bottom',
    requiredView: 'console',
    requiredTab: 'terminals',
  },

  // ============================================================
  // GRAND FINALE: Download & Run Bedrock Locally (Step 14)
  // ============================================================
  {
    id: 'download_app',
    stepNumber: 14,
    phase: 2,
    phaseTitle: 'Get Bedrock',
    targetSelector: '[data-tour="download-modal"]',
    fallbackSelector: '.download-modal-container, .hero-actions',
    title: 'Download & Run Bedrock Locally',
    subtitle: 'Native Desktop Application',
    description:
      'Get Bedrock for Windows (.exe / .zip), macOS, or Linux. Enjoy full native performance with local persistence.',
    tooltipText:
      'Download your desktop build directly or explore the web control center right away!',
    preferredPlacement: 'top',
    isDownloadStep: true,
  },
];
