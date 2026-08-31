import { Component, ErrorInfo, ReactNode } from 'react';
import { logger } from '../lib/logger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary component to catch JavaScript errors anywhere in the child component tree.
 * Displays a fallback UI instead of crashing the entire application.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('ErrorBoundary caught an error:', error);
    logger.error('Component stack:', errorInfo.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex h-screen items-center justify-center bg-gray-900">
          <div className="mx-4 w-full max-w-md rounded-lg bg-gray-800 p-6 shadow-xl">
            <div className="text-center">
              <div className="mb-4">
                <svg
                  className="mx-auto h-16 w-16 text-red-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              </div>
              <h2 className="mb-2 text-xl font-semibold text-white">Something went wrong</h2>
              <p className="mb-6 text-gray-400">
                An unexpected error occurred. Please try again or restart the application.
              </p>
              {this.state.error && (
                <details className="mb-6 text-left">
                  <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-400">
                    Error details
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-900 p-3 text-xs text-red-400">
                    {this.state.error.message}
                    {this.state.error.stack && (
                      <>
                        {'\n\n'}
                        {this.state.error.stack}
                      </>
                    )}
                  </pre>
                </details>
              )}
              <div className="flex justify-center gap-3">
                <button
                  onClick={this.handleRetry}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
                >
                  Try Again
                </button>
                <button
                  onClick={() => window.location.reload()}
                  className="rounded-lg bg-gray-700 px-4 py-2 text-white transition-colors hover:bg-gray-600"
                >
                  Reload App
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
