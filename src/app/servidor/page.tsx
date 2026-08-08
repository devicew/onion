import { CleanerForm } from "../cleaner-form";
import { SiteShell } from "../site-shell";
import styles from "../page.module.css";

export default function ServidorPage() {
  return (
    <SiteShell currentTool="servidor">
      <section className={styles.hero}>
        <p className={styles.kicker}>CL em servidor</p>
        <h1 className={styles.title}>Limpeza no servidor</h1>
        <p className={styles.subtitle}>
          Informe o token e o ID de um canal de texto ou do chat de um canal de
          voz. Apaga até o fim, com a mesma ordem e pausa da limpeza em DM.
        </p>
      </section>

      <section className={styles.panel}>
        <CleanerForm mode="guild" />
      </section>
    </SiteShell>
  );
}
