import Link from "next/link";
import styles from "./page.module.css";

type ToolId = "dm" | "servidor" | "alerta";

type SiteShellProps = {
  children: React.ReactNode;
  currentTool?: ToolId;
  moreHref?: string;
  moreLabel?: string;
};

export function SiteShell({
  children,
  currentTool,
  moreHref,
  moreLabel = "Mais opções",
}: SiteShellProps) {
  const href =
    moreHref ??
    (currentTool ? `/opcoes?atual=${currentTool}` : "/opcoes");

  return (
    <div className={styles.page}>
      <div className={styles.atmosphere} aria-hidden>
        <span className={styles.grid} />
      </div>

      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandDot} aria-hidden />
          <span className={styles.brandName}>Onion</span>
        </Link>
        <Link href={href} className={styles.moreLink}>
          {moreLabel}
        </Link>
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  );
}
