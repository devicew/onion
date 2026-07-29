import Link from "next/link";
import { SiteShell } from "../site-shell";
import styles from "../page.module.css";
import optionStyles from "./opcoes.module.css";

type ToolId = "dm" | "servidor";

const OPTIONS: Array<{
  id: ToolId | "friends" | "groups" | "export";
  href: string;
  title: string;
  description: string;
  available: boolean;
}> = [
  {
    id: "dm",
    href: "/",
    title: "CL em DM",
    description: "Limpe suas mensagens em conversas diretas.",
    available: true,
  },
  {
    id: "servidor",
    href: "/servidor",
    title: "CL em servidor",
    description:
      "Limpe suas mensagens em canal de texto ou no chat de um canal de voz.",
    available: true,
  },
  {
    id: "friends",
    href: "#",
    title: "CL em amigos",
    description: "Limpeza em massa nas conversas com amigos.",
    available: false,
  },
  {
    id: "groups",
    href: "#",
    title: "CL em grupos",
    description: "Remova suas mensagens em grupos privados.",
    available: false,
  },
  {
    id: "export",
    href: "#",
    title: "Exportar histórico",
    description: "Baixe um backup antes de limpar.",
    available: false,
  },
];

export default async function OpcoesPage({
  searchParams,
}: {
  searchParams: Promise<{ atual?: string }>;
}) {
  const params = await searchParams;
  const atual =
    params.atual === "servidor" || params.atual === "dm"
      ? params.atual
      : undefined;

  const backHref =
    atual === "servidor" ? "/servidor" : atual === "dm" ? "/" : "/";

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

          if (!option.available) {
            return (
              <div
                key={option.id}
                className={`${optionStyles.card} ${optionStyles.cardDisabled}`}
                aria-disabled="true"
              >
                <span className={optionStyles.cardTitle}>
                  {option.title}
                  <span className={optionStyles.soon}>Em breve</span>
                </span>
                <span className={optionStyles.cardDesc}>
                  {option.description}
                </span>
              </div>
            );
          }

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
