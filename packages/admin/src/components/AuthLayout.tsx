/**
 * The frame of the sign-in screens (mockup Login): a charcoal panel with an
 * honest placeholder caption beside a column with the Oculus wordmark, the
 * screen's heading and one plain sentence about it, then the form.
 */
import type { ReactNode } from "react";
import styles from "./AuthLayout.module.css";

export function AuthLayout(props: {
  readonly title: string;
  readonly intro: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#main">
        Skip to main content
      </a>
      <div className={styles.picture} aria-hidden="true">
        <p className={styles.caption}>[Photo from the collection]</p>
      </div>
      <main id="main" className={styles.panel} tabIndex={-1}>
        <div className={styles.column}>
          <div className={styles.brand}>
            <span className={styles.wordmark}>Oculus</span>
            <span className={styles.tagline}>Collections and archive</span>
          </div>
          <h1 className={styles.title}>{props.title}</h1>
          <p className={styles.intro}>{props.intro}</p>
          {props.children}
        </div>
      </main>
    </div>
  );
}

export const authStyles = styles;
