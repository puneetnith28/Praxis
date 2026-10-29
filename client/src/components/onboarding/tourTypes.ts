export type TourPhase = 1 | 2;

export interface TourStepConfig {
  id: string;
  stepNumber: number;
  phase: TourPhase;
  phaseTitle: string;
  targetSelector: string;
  fallbackSelector?: string;
  title: string;
  subtitle: string;
  description: string;
  tooltipText: string;
  preferredPlacement?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  requiresHumanApproval?: boolean;
  requiredTab?: 'terminals' | 'messages' | 'groupchat';
  requiredView?: 'landing' | 'console';
  isDownloadStep?: boolean;
}

export type TourStage =
  | 'idle'
  | 'welcome'
  | 'step'
  | 'phase_transition'
  | 'completion'
  | 'done';

export interface CursorPosition {
  x: number;
  y: number;
  visible: boolean;
  clicking?: boolean;
  hovering?: boolean;
}

export interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
  borderRadius?: number;
}
