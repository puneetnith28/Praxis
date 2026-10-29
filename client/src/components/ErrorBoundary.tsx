import React from 'react';

/**
 * Catches a render error instead of letting it blank the page.
 *
 * Without one, a single throw anywhere in the tree unmounts everything and
 * leaves a white screen — while the agents keep running in the daemon, now
 * invisible and uncontrollable. That is the worst possible failure for a
 * control centre, and the recovery (reload the page; the daemon kept your
 * agents) is not something a user can be expected to guess.
 */
interface Props {
  children: React.ReactNode;
  /** Shown in the message, so the user knows which part failed. */
  area?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[bedrock] render error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <h1 className="crash-title">Something in the interface broke</h1>
        <p className="crash-lead">
          {this.props.area ? `The ${this.props.area} failed to render. ` : ''}
          Your agents are unaffected — the daemon runs them in a separate process
          and they are still going. Reloading reconnects to them.
        </p>
        <pre className="crash-detail">{error.message}</pre>
        <div className="crash-actions">
          <button className="batch-btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className="batch-btn" onClick={() => this.setState({ error: null })}>
            Try again without reloading
          </button>
        </div>
        <p className="crash-note">
          If it keeps happening, the browser console has the component that threw.
        </p>
      </div>
    );
  }
}
