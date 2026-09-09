import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <section className="panel max-w-md p-8 text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-ngo-600">Private storage gateway</p>
        <h1 className="mt-3 text-2xl font-bold text-ink-900">Page not found</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">This link is unavailable or the document no longer exists.</p>
        <Link className="mt-6 inline-flex rounded-lg bg-ngo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ngo-700" href="/admin/dashboard">Return to dashboard</Link>
      </section>
    </main>
  );
}
