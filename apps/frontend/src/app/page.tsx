import { Activity, CheckCircle2, Clock, MessageSquare, ShieldCheck, Users } from "lucide-react";

const metrics = [
  { label: "Campanhas em draft", value: "3", icon: Clock },
  { label: "Contatos descobertos", value: "78", icon: Users },
  { label: "Opt-ins pendentes", value: "42", icon: ShieldCheck },
  { label: "Envios no grupo", value: "12", icon: MessageSquare }
];

const timeline = [
  ["09:00", "Grupo", "Mensagem programada aguardando aprovacao"],
  ["09:12", "Audio", "Instrucao transcrita e marcada para revisao"],
  ["10:15", "Consentimento", "Template de opt-in pronto para submissao"],
  ["12:00", "Provider", "UAZAPI conectado e grupo allowlistado"]
];

export default function Home() {
  return (
    <main className="min-h-screen px-6 py-6 lg:px-10">
      <section className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">Cognita Campaign Engine</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-normal text-ink">
              Command Center
            </h1>
          </div>
          <div className="flex items-center gap-3 rounded-full border border-line bg-white px-4 py-2 text-sm text-slate-600 shadow-sm">
            <span className="h-2 w-2 rounded-full bg-success" />
            MVP foundation online
          </div>
        </header>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <article
              key={metric.label}
              className="rounded-lg border border-line bg-white p-5 shadow-panel"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500">{metric.label}</p>
                <metric.icon className="h-5 w-5 text-slate-400" aria-hidden="true" />
              </div>
              <p className="mt-4 text-3xl font-semibold text-ink">{metric.value}</p>
            </article>
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-lg border border-line bg-white p-6 shadow-panel">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-ink">Fluxo MVP</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Grupo, extracao, opt-in oficial e consentimento.
                </p>
              </div>
              <Activity className="h-5 w-5 text-accent" aria-hidden="true" />
            </div>

            <div className="mt-6 grid gap-3">
              {[
                "Validar grupo allowlistado",
                "Extrair contatos como group_member_discovered",
                "Enviar template oficial de opt-in",
                "Liberar sequencias apenas para opted_in"
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-3 rounded-md border border-line bg-mist px-4 py-3"
                >
                  <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
                  <span className="text-sm font-medium text-slate-700">{item}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-line bg-white p-6 shadow-panel">
            <h2 className="text-lg font-semibold text-ink">Timeline</h2>
            <div className="mt-5 space-y-4">
              {timeline.map(([time, source, text]) => (
                <div key={`${time}-${source}`} className="grid grid-cols-[64px_1fr] gap-4">
                  <span className="text-sm font-medium text-slate-400">{time}</span>
                  <div className="border-l border-line pl-4">
                    <p className="text-sm font-semibold text-ink">{source}</p>
                    <p className="mt-1 text-sm text-slate-500">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

