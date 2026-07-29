import Link from "next/link";
import styles from "./page.module.css";

type SiteShellProps = {
  children: React.ReactNode;
  moreHref?: string;
  moreLabel?: string;
};

export function SiteShell({
  children,
  moreHref = "/opcoes",
  moreLabel = "Mais opções",
}: SiteShellProps) {
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
        <Link href={moreHref} className={styles.moreLink}>
          {moreLabel}
        </Link>
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  );
}
