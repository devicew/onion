import Link from "next/link";
import { SiteShell } from "../site-shell";
import styles from "../page.module.css";
import optionStyles from "./opcoes.module.css";

type ToolId = "dm" | "servidor" | "alerta";

const OPTIONS: Array<{
  id: ToolId;
  href: string;
  title: string;
  description: string;
}> = [
  {
    id: "dm",
    href: "/",
    title: "CL em DM",
    description: "Limpe suas mensagens em conversas diretas.",
  },
  {
    id: "servidor",
    href: "/servidor",
    title: "CL em servidor",
    description:
      "Limpe suas mensagens em canal de texto ou no chat de um canal de voz.",
  },
  {
    id: "alerta",
    href: "/alerta",
    title: "Alerta de call",
    description:
      "Receba aviso quando um amigo entrar em um canal de voz para entrar junto.",
  },
];

export default async function OpcoesPage({
  searchParams,
}: {
  searchParams: Promise<{ atual?: string }>;
}) {
  const params = await searchParams;
  const atual =
    params.atual === "servidor" ||
    params.atual === "dm" ||
    params.atual === "alerta"
      ? params.atual
      : undefined;

  const backHref =
    atual === "servidor"
      ? "/servidor"
      : atual === "alerta"
        ? "/alerta"
        : "/";

  return (
    <SiteShell moreHref={backHref} moreLabel="Voltar">
      <section className={styles.hero}>
        <p className={styles.kicker}>Mais opções</p>
        <h1 className={styles.title}>Escolha uma ferramenta</h1>
        <p className={styles.subtitle}>
          Veja todas as ferramentas. A que você está usando agora aparece
          marcada.
        </p>
      </section>

      <section className={optionStyles.grid}>
        {OPTIONS.map((option) => {
          const isCurrent = atual === option.id;

          return (
            <Link
              key={option.id}
              href={option.href}
              className={`${optionStyles.card} ${
                isCurrent ? optionStyles.cardActive : ""
              }`}
              aria-current={isCurrent ? "page" : undefined}
            >
              <span className={optionStyles.cardTitle}>
                {option.title}
                {isCurrent && (
                  <span className={optionStyles.current}>Em uso</span>
                )}
              </span>
              <span className={optionStyles.cardDesc}>{option.description}</span>
            </Link>
          );
        })}
      </section>
    </SiteShell>
  );
}
