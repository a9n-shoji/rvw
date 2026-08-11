import { Component, type ErrorInfo, type ReactNode } from "react";

export class LazyLoadBoundary extends Component<
  { children: ReactNode; label: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`${this.props.label}の遅延読み込みに失敗しました。`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="viewer-unavailable">
        <span>LOAD</span>
        <p>{this.props.label}を読み込めませんでした。</p>
        <button onClick={() => window.location.reload()}>ページを再読み込み</button>
      </div>
    );
  }
}
