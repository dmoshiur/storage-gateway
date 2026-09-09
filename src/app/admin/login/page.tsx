import { FileText, ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";

export const metadata = { title: "Admin sign in" };

export default function LoginPage() {
  return (
    <main className="grid min-h-screen bg-gradient-to-br from-ngo-50 via-slate-50 to-white lg:grid-cols-2">
      <section className="hidden bg-ink-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3 text-lg font-bold"><span className="grid h-10 w-10 place-items-center rounded-xl bg-ngo-500"><FileText className="h-5 w-5" /></span>NGO PDF Storage</div>
        <div className="max-w-md"><p className="text-sm font-bold uppercase tracking-[0.2em] text-ngo-100">Private gateway</p><h1 className="mt-4 text-4xl font-bold leading-tight">Protect the documents that support your mission.</h1><p className="mt-5 leading-7 text-slate-300">A focused, private workspace for authorized staff to retain, find, and safely manage NGO PDF records.</p></div>
        <p className="flex items-center gap-2 text-sm text-slate-400"><ShieldCheck className="h-5 w-5 text-ngo-100" />Private R2 storage · Firebase-verified access</p>
      </section>
      <section className="flex items-center justify-center p-5 sm:p-10">
        <div className="w-full max-w-md">
          <div className="mb-7 flex items-center gap-3 lg:hidden"><span className="grid h-10 w-10 place-items-center rounded-xl bg-ngo-600 text-white"><FileText className="h-5 w-5" /></span><span className="font-bold text-ink-900">NGO PDF Storage</span></div>
          <div className="panel p-6 sm:p-8"><p className="text-sm font-semibold uppercase tracking-wider text-ngo-600">Administrator access</p><h1 className="mt-2 text-2xl font-bold text-ink-900">Sign in to storage</h1><p className="mt-2 text-sm leading-6 text-slate-600">Enter the administrator passphrase, then sign in with your authorized Firebase account. Unauthenticated visitors cannot access documents or settings.</p><div className="mt-7"><LoginForm /></div></div>
        </div>
      </section>
    </main>
  );
}
