import type { Metadata } from 'next';
import { Sidebar } from '@/components/layout/sidebar';
import './globals.css';

export const metadata: Metadata = {
  title: 'FlowRadar',
  description: 'Money-flow and wallet-behavior analytics — not financial advice.',
};

// Dark theme is the permanent default (binding decision #4) — no theme
// toggle, no next-themes/prefers-color-scheme wiring. <html class="dark">
// unconditionally activates app/globals.css's single dark palette.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
