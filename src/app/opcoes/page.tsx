import Link from "next/link";
import { SiteShell } from "../site-shell";
import styles from "../page.module.css";
import optionStyles from "./opcoes.module.css";

const OPTIONS = [
  {
    href: "/servidor",
    title: "CL em servidor",
    description:
      "Limpe suas mensagens em canal de texto ou no chat de um canal de voz.",
    available: true,
  },
  {
    href: "#",
    title: "CL em amigos",
    description: "Limpeza em massa nas conversas com amigos.",
    available: false,
  },
  {
    href: "#",
    title: "CL em grupos",
    description: "Remova suas mensagens em grupos privados.",
    available: false,
  },
  {
    href: "#",
    title: "Exportar histórico",
    description: "Baixe um backup antes de limpar.",
    available: false,
  },
];

export default function OpcoesPage() {
  return (
    <SiteShell moreHref="/" moreLabel="Voltar">
      <section className={styles.hero}>
        <p className={styles.kicker}>Mais opções</p>
        <h1 className={styles.title}>Escolha uma ferramenta</h1>
        <p className={styles.subtitle}>
          Selecione uma das opções abaixo. As indisponíveis ficam marcadas como
          em breve.
        </p>
      </section>

      <section className={optionStyles.grid}>
        {OPTIONS.map((option) =>
          option.available ? (
            <Link
              key={option.title}
              href={option.href}
              className={optionStyles.card}
            >
              <span className={optionStyles.cardTitle}>{option.title}</span>
              <span className={optionStyles.cardDesc}>{option.description}</span>
            </Link>
          ) : (
            <div
              key={option.title}
              className={`${optionStyles.card} ${optionStyles.cardDisabled}`}
              aria-disabled="true"
            >
              <span className={optionStyles.cardTitle}>
                {option.title}
                <span className={optionStyles.soon}>Em breve</span>
              </span>
              <span className={optionStyles.cardDesc}>{option.description}</span>
            </div>
          ),
        )}
      </section>
    </SiteShell>
  );
}
