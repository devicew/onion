import { CleanerForm } from "./cleaner-form";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <div className={styles.atmosphere} aria-hidden>
        <span className={styles.grid} />
      </div>

      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandDot} aria-hidden />
          <span className={styles.brandName}>Onion</span>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <p className={styles.kicker}>DM Cleaner</p>
          <h1 className={styles.title}>Limpeza de DMs</h1>
          <p className={styles.subtitle}>
            Informe o token da conta e o ID do canal para remover suas
            mensagens.
          </p>
        </section>

        <section className={styles.panel}>
          <CleanerForm />
        </section>
      </main>
    </div>
  );
}
