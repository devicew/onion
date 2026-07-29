import { CleanerForm } from "./cleaner-form";
import { SiteShell } from "./site-shell";
import styles from "./page.module.css";

export default function Home() {
  return (
    <SiteShell>
      <section className={styles.hero}>
        <p className={styles.kicker}>CL em DM</p>
        <h1 className={styles.title}>Limpeza de DMs</h1>
        <p className={styles.subtitle}>
          Informe o token da conta e o ID do canal para remover suas mensagens
          diretas.
        </p>
      </section>

      <section className={styles.panel}>
        <CleanerForm mode="dm" />
      </section>
    </SiteShell>
  );
}
