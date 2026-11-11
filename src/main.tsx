import React, { Component, ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

interface RootBoundaryState {
  hasError: boolean;
  message: string;
}

class RootErrorBoundary extends Component<
  { children: ReactNode },
  RootBoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): RootBoundaryState {
    return {
      hasError: true,
      message: error?.message || '页面初始化发生异常',
    };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Prevent blank screen if an unexpected render exception occurs
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full bg-[#0B0F17] text-[#F1F5F9] flex flex-col items-center justify-center p-6 text-center gap-3">
          <div className="text-base font-semibold">Dor.ED 安全恢复模式</div>
          <div className="text-xs text-[#94A3B8] max-w-md">
            {this.state.message}
          </div>
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.removeItem('dored_cad_prefs_v1');
              } catch {
                // ignore
              }
              this.setState({ hasError: false, message: '' });
            }}
            className="px-4 py-1.5 rounded bg-[#0284C7] hover:bg-[#0369A1] text-xs font-medium text-white"
          >
            重置偏好并恢复界面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  );
}
