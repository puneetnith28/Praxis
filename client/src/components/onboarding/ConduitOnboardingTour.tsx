import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TOUR_STEPS } from './onboardingConfig';
import type { TourStage, TargetRect, CursorPosition } from './tourTypes';
import { TourSpotlight } from './TourSpotlight';
import { TourCursor } from './TourCursor';
import { TourTooltip } from './TourTooltip';
import { TourWelcome } from './TourWelcome';
import { TourPhaseTransition } from './TourPhaseTransition';
import { TourCompletion } from './TourCompletion';
import { TourApprovalGate } from './TourApprovalGate';
import {
  TourTerminalDemo,
  TourGroupChatDemo,
  TourMcpDemo,
  TourKeeperDemo,
} from './TourSimulatedDemos';
import './tour.css';

interface ConduitOnboardingTourProps {
  forceStart?: boolean;
  onClose?: () => void;
  onTabChange?: (tab: 'terminals' | 'messages' | 'groupchat') => void;
  onViewChange?: (view: 'landing' | 'console') => void;
  onEnsureDemoWorkspace?: () => void;
  isDownloadModalOpen?: boolean;
  onOpenDownloadModal?: () => void;
  onCloseDownloadModal?: () => void;
}

export const ConduitOnboardingTour: React.FC<ConduitOnboardingTourProps> = ({
  forceStart = false,
  onClose,
  onTabChange,
  onViewChange,
  onEnsureDemoWorkspace,
  isDownloadModalOpen = false,
  onOpenDownloadModal,
  onCloseDownloadModal,
}) => {
  const [stage, setStage] = useState<TourStage>('idle');
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [cursor, setCursor] = useState<CursorPosition>({
    x: -100,
    y: -100,
    visible: false,
    clicking: false,
  });
  const [gateApproved, setGateApproved] = useState<boolean>(false);

  const downloadModalOpenedRef = useRef<boolean>(false);
  const prevDownloadOpenRef = useRef<boolean>(false);

  const activeStep = TOUR_STEPS[stepIndex];
  const totalSteps = TOUR_STEPS.length; // 14 steps

  // Check localStorage on mount
  useEffect(() => {
    if (forceStart) {
      downloadModalOpenedRef.current = false;
      setStage('step');
      setStepIndex(0);
      return;
    }

    const completed = localStorage.getItem('bedrock-onboarding-completed') || localStorage.getItem('conduit-onboarding-completed');
    const skipped = localStorage.getItem('bedrock-onboarding-skipped') || localStorage.getItem('conduit-onboarding-skipped');

    if (!completed && !skipped) {
      // Short delay for natural UI render before showing welcome
      const timer = setTimeout(() => {
        setStage('welcome');
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [forceStart]);

  // Handle target measurement and smooth scroll
  const updateTargetRect = useCallback(() => {
    if (stage !== 'step' || !activeStep) {
      setTargetRect(null);
      return;
    }

    let el = document.querySelector(activeStep.targetSelector);
    if (!el && activeStep.fallbackSelector) {
      el = document.querySelector(activeStep.fallbackSelector);
    }

    if (el) {
      // Smoothly scroll to target element if not fully in view
      const elemRect = el.getBoundingClientRect();
      const inView =
        elemRect.top >= 0 &&
        elemRect.bottom <= (window.innerHeight || document.documentElement.clientHeight);

      if (!inView && activeStep.requiredView === 'landing') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const radius = parseFloat(style.borderRadius) || 8;

      setTargetRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        borderRadius: radius,
      });

      // Choreograph cursor toward target center
      const targetCenterX = rect.left + Math.min(rect.width * 0.45, 140);
      const targetCenterY = rect.top + Math.min(rect.height * 0.5, 60);

      setCursor((prev) => ({
        ...prev,
        x: targetCenterX,
        y: targetCenterY,
        visible: true,
        clicking: false,
      }));

      // Subtle click feedback on arrival
      const clickTimer = setTimeout(() => {
        setCursor((c) => ({ ...c, clicking: true }));
        setTimeout(() => setCursor((c) => ({ ...c, clicking: false })), 200);
      }, 400);

      return () => clearTimeout(clickTimer);
    } else {
      setTargetRect(null);
    }
  }, [stage, activeStep]);

  // Sync view, tab, download modal, and target tracking when step changes
  useEffect(() => {
    if (stage !== 'step' || !activeStep) return;

    // View synchronization (Landing vs Console)
    if (activeStep.requiredView === 'landing') {
      onViewChange?.('landing');
    } else if (activeStep.requiredView === 'console') {
      onViewChange?.('console');
      onEnsureDemoWorkspace?.();
    }

    // Tab synchronization
    if (activeStep.requiredTab && onTabChange) {
      onTabChange(activeStep.requiredTab);
    }

    // Download modal management
    if (activeStep.isDownloadStep) {
      if (!downloadModalOpenedRef.current) {
        downloadModalOpenedRef.current = true;
        onOpenDownloadModal?.();
      }
    } else {
      if (downloadModalOpenedRef.current) {
        downloadModalOpenedRef.current = false;
        onCloseDownloadModal?.();
      }
    }

    // Allow DOM to settle, then measure
    const timer = setTimeout(() => {
      updateTargetRect();
    }, 150);

    const handleResize = () => updateTargetRect();
    const handleScroll = () => updateTargetRect();

    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [stage, stepIndex, activeStep, onViewChange, onTabChange, onEnsureDemoWorkspace, onOpenDownloadModal, onCloseDownloadModal, updateTargetRect]);

  // Handle user closing the download modal (via X button, backdrop, or Escape) while on download step
  useEffect(() => {
    if (
      prevDownloadOpenRef.current &&
      !isDownloadModalOpen &&
      stage === 'step' &&
      activeStep?.isDownloadStep
    ) {
      downloadModalOpenedRef.current = false;
      localStorage.setItem('bedrock-onboarding-completed', '1');
      localStorage.setItem('conduit-onboarding-completed', '1');
      setStage('done');
      setCursor((c) => ({ ...c, visible: false }));
      onClose?.();
    }
    prevDownloadOpenRef.current = !!isDownloadModalOpen;
  }, [isDownloadModalOpen, stage, activeStep, onClose]);

  // Keyboard controls: Escape to close/skip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (stage === 'idle' || stage === 'done') return;
      if (e.key === 'Escape') {
        handleSkip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage]);

  // Tour navigation handlers
  const handleStartTour = () => {
    downloadModalOpenedRef.current = false;
    setStage('step');
    setStepIndex(0);
    setCursor({ x: window.innerWidth / 2, y: window.innerHeight / 2, visible: true });
  };

  const handleSkip = () => {
    downloadModalOpenedRef.current = false;
    localStorage.setItem('bedrock-onboarding-skipped', '1');
    localStorage.setItem('conduit-onboarding-skipped', '1');
    setStage('done');
    setCursor((c) => ({ ...c, visible: false }));
    onCloseDownloadModal?.();
    onClose?.();
  };

  const handleNext = () => {
    // Step 5: Transition from Platform Overview (Landing Page) to Inside Control Center (Console)
    if (stepIndex === 4) {
      setStage('phase_transition');
      return;
    }

    // Last Step (Step 14: Download Step)
    if (stepIndex === totalSteps - 1) {
      downloadModalOpenedRef.current = false;
      onCloseDownloadModal?.();
      setStage('completion');
      setCursor((c) => ({ ...c, visible: false }));
      return;
    }

    setStepIndex((curr) => curr + 1);
  };

  const handleBack = () => {
    if (stepIndex > 0) {
      setStepIndex((curr) => curr - 1);
    }
  };

  const handlePhaseTransitionComplete = () => {
    onViewChange?.('console');
    onEnsureDemoWorkspace?.();
    setStage('step');
    setStepIndex(5); // Step 6 (first step inside console)
    setGateApproved(false);
  };

  const handleGateApproved = () => {
    setGateApproved(true);
    // Automatic advance after brief success state
    setTimeout(() => {
      setStepIndex(9); // Advance to Step 10
    }, 1100);
  };

  const handleFinishExploring = () => {
    downloadModalOpenedRef.current = false;
    localStorage.setItem('bedrock-onboarding-completed', '1');
    localStorage.setItem('conduit-onboarding-completed', '1');
    setStage('done');
    setCursor((c) => ({ ...c, visible: false }));
    onCloseDownloadModal?.();
    onClose?.();
  };

  if (stage === 'idle' || stage === 'done') {
    return null;
  }

  return (
    <div className="tour-overlay-root">
      {/* 1. Spotlight Dim Backdrop & Cutout (not needed on download step as the modal has its own backdrop) */}
      {stage === 'step' && !activeStep?.isDownloadStep && <TourSpotlight targetRect={targetRect} />}

      {/* 2. Simulated Cursor */}
      <TourCursor cursor={cursor} />

      {/* 3. Welcome Introduction */}
      {stage === 'welcome' && (
        <TourWelcome onStart={handleStartTour} onSkip={handleSkip} />
      )}

      {/* 4. Active Step Coach Mark */}
      {stage === 'step' && activeStep && (
        <>
          <TourTooltip
            step={activeStep}
            totalSteps={totalSteps}
            targetRect={targetRect}
            onNext={handleNext}
            onBack={handleBack}
            onSkip={handleSkip}
            canAdvance={!activeStep.requiresHumanApproval || gateApproved}
          />

          {/* Step 8 (Real Terminal): Progressive test run micro-demo */}
          {activeStep.id === 'terminal' && (
            <div
              style={{
                position: 'fixed',
                bottom: 24,
                left: 24,
                width: 320,
                zIndex: 99994,
                pointerEvents: 'none',
              }}
            >
              <TourTerminalDemo />
            </div>
          )}

          {/* Step 9 (Approval Gate): Intercepted command and Approve button */}
          {activeStep.id === 'approval_gate' && (
            <TourApprovalGate
              onApproved={handleGateApproved}
              onReject={handleBack}
            />
          )}

          {/* Step 11 (Group Chat): Sequential messages */}
          {activeStep.id === 'group_chat' && (
            <div
              style={{
                position: 'fixed',
                bottom: 24,
                right: 24,
                width: 320,
                zIndex: 99994,
                pointerEvents: 'none',
              }}
            >
              <TourGroupChatDemo />
            </div>
          )}

          {/* Step 12 (MCP Messaging): Peer-to-peer packet animation */}
          {activeStep.id === 'mcp_messaging' && (
            <div
              style={{
                position: 'fixed',
                bottom: 24,
                right: 24,
                width: 300,
                zIndex: 99994,
                pointerEvents: 'none',
              }}
            >
              <TourMcpDemo />
            </div>
          )}

          {/* Step 13 (Keeper Orchestrator): Structured telemetry */}
          {activeStep.id === 'keeper_command' && (
            <div
              style={{
                position: 'fixed',
                top: 60,
                right: 32,
                width: 300,
                zIndex: 99994,
                pointerEvents: 'none',
              }}
            >
              <TourKeeperDemo />
            </div>
          )}
        </>
      )}

      {/* 5. Phase Transition Intermission */}
      {stage === 'phase_transition' && (
        <TourPhaseTransition
          eyebrow="PHASE 2"
          heading="Inside the Control Center"
          message="Now let's step inside the live Bedrock Control Center workspace."
          onComplete={handlePhaseTransitionComplete}
        />
      )}

      {/* 6. Completion State Card */}
      {stage === 'completion' && (
        <TourCompletion onFinish={handleFinishExploring} />
      )}
    </div>
  );
};

export default ConduitOnboardingTour;
