import { VoiceAlertForm } from "../voice-alert-form";
import { SiteShell } from "../site-shell";
import styles from "../page.module.css";

export default function AlertaPage() {
  return (
    <SiteShell currentTool="alerta">
      <section className={styles.hero}>
        <p className={styles.kicker}>Alerta de call</p>
        <h1 className={styles.title}>Aviso quando o amigo entrar</h1>
        <p className={styles.subtitle}>
          Use seu token e o ID do amigo. Se ele já estiver em call, o aviso
          aparece na hora. Se não, o site continua observando e alerta assim
          que ele entrar.
        </p>
      </section>

      <section className={styles.panel}>
        <VoiceAlertForm />
      </section>
    </SiteShell>
  );
}
