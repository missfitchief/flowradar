import { redirect } from 'next/navigation';

// Product-rescue sprint: the operator lands on Active Setups (decision-first
// view). The old Signal Feed landing page moved to /feed (Advanced).
export default function Home() {
  redirect('/setups');
}
