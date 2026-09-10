import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  scope?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ""}]`, error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      const error = this.state.error;
      return (
        <div className="grid min-h-dvh place-items-center px-5 py-10">
          <div className="w-full max-w-md rounded-2xl border border-[var(--color-edge)] bg-[var(--surface)] p-6 text-center shadow-lg">
            <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-[color-mix(in_srgb,var(--color-danger)_15%,var(--surface))] text-[var(--color-danger)]">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <h2 className="text-lg font-bold tracking-tight">页面出错了</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {import.meta.env.PROD
                ? "很抱歉，出现了一个意外错误。请刷新页面重试。"
                : error.message || error.name || "未知错误"}
            </p>
            {!import.meta.env.PROD && error.stack ? (
              <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-black/5 p-3 text-left text-[11px] leading-5 text-[var(--color-muted)]">
                {error.stack}
              </pre>
            ) : null}
            <div className="mt-5 flex justify-center gap-2">
              <button className="btn" onClick={this.handleReset}>
                重试
              </button>
              <button className="btn btn-primary" onClick={this.handleReload}>
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
