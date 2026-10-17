/**
 * 加载门（loading gate）遮罩：区域切换/流式加载期间用全屏黑场掩蔽。
 * 纯 DOM + CSS transition，不依赖 Babylon；供 region-loading / region-gate 场景复用。
 */

export type LoadingGateState = "masked" | "revealing" | "visible";

const GATE_ELEMENT_ID = "p0-loading-gate";
const GATE_STYLE_ID = "p0-loading-gate-style";

export interface LoadingGate {
  readonly element: HTMLDivElement;
  readonly state: LoadingGateState;
  /** 淡入黑场，resolve 时遮罩已完全覆盖，返回实际耗时（ms）。 */
  maskIn(durationMs: number): Promise<number>;
  /** 淡出黑场，resolve 时场景已完全可见，返回实际耗时（ms）。 */
  maskOut(durationMs: number): Promise<number>;
  isMasked(): boolean;
  dispose(): void;
}

function ensureGateStyle(): void {
  if (document.getElementById(GATE_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = GATE_STYLE_ID;
  style.textContent = `
    #${GATE_ELEMENT_ID} {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: #000;
      opacity: 0;
      pointer-events: none;
      will-change: opacity;
      transition-property: opacity;
      transition-timing-function: ease-in-out;
    }
  `;
  document.head.append(style);
}

class DomLoadingGate implements LoadingGate {
  readonly element: HTMLDivElement;
  private currentState: LoadingGateState = "visible";

  constructor() {
    ensureGateStyle();
    const existing = document.getElementById(GATE_ELEMENT_ID);
    if (existing instanceof HTMLDivElement) {
      this.element = existing;
    } else {
      this.element = document.createElement("div");
      this.element.id = GATE_ELEMENT_ID;
      this.element.setAttribute("aria-hidden", "true");
      this.element.dataset.gateState = "visible";
      document.body.append(this.element);
    }
  }

  get state(): LoadingGateState {
    return this.currentState;
  }

  isMasked(): boolean {
    return this.currentState === "masked";
  }

  maskIn(durationMs: number): Promise<number> {
    return this.transitionTo(1, Math.max(0, durationMs), "masked");
  }

  maskOut(durationMs: number): Promise<number> {
    return this.transitionTo(0, Math.max(0, durationMs), "visible");
  }

  dispose(): void {
    this.element.remove();
    document.getElementById(GATE_STYLE_ID)?.remove();
  }

  private transitionTo(
    opacity: number,
    durationMs: number,
    targetState: LoadingGateState,
  ): Promise<number> {
    const startedAt = performance.now();
    this.element.style.transitionDuration = `${durationMs}ms`;
    // 强制一次样式计算，确保从当前 opacity 开始过渡。
    void this.element.offsetWidth;
    this.element.style.opacity = String(opacity);
    this.element.dataset.gateState = targetState;
    this.currentState = targetState;

    if (durationMs === 0) {
      return Promise.resolve(performance.now() - startedAt);
    }

    return new Promise<number>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.element.removeEventListener("transitionend", onTransitionEnd);
        window.clearTimeout(fallbackTimer);
        resolve(performance.now() - startedAt);
      };
      const onTransitionEnd = (event: TransitionEvent): void => {
        if (event.target === this.element && event.propertyName === "opacity") {
          finish();
        }
      };
      // transitionend 在后台标签页可能被节流，兜底保证场景不会卡死。
      const fallbackTimer = window.setTimeout(finish, durationMs + 120);
      this.element.addEventListener("transitionend", onTransitionEnd);
    });
  }
}

let sharedGate: LoadingGate | null = null;

/** 进程内共享的加载门；场景运行期间保持同一遮罩，避免重复创建。 */
export function getLoadingGate(): LoadingGate {
  if (!sharedGate) {
    sharedGate = new DomLoadingGate();
  }
  return sharedGate;
}

/** 场景结束时释放共享遮罩（下一次按需重建）。 */
export function releaseLoadingGate(): void {
  sharedGate?.dispose();
  sharedGate = null;
}
