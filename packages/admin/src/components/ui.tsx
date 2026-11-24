/**
 * Shared controls built on React Aria Components (D-073), styled with the
 * design tokens: a labelled text field with help and error text, buttons,
 * links that look like links, and the three notes of DESIGN.md §6.
 */
import type { ReactNode } from "react";
import {
  Button as AriaButton,
  FieldError,
  Input,
  Label,
  Link as AriaLink,
  Text,
  TextField,
} from "react-aria-components";
import styles from "./ui.module.css";

export interface FieldProps {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: "text" | "email" | "password";
  readonly autoComplete?: string;
  readonly inputMode?: "text" | "numeric" | "email";
  readonly help?: string;
  /** Shown under the field and announced; also marks it invalid. */
  readonly error?: string | undefined;
  readonly isRequired?: boolean;
  readonly autoFocus?: boolean;
  readonly maxLength?: number;
}

/** A labelled text field (label above, help and error below). */
export function Field(props: FieldProps) {
  return (
    <TextField
      className={styles.field}
      name={props.name}
      value={props.value}
      onChange={props.onChange}
      type={props.type ?? "text"}
      isRequired={props.isRequired ?? false}
      isInvalid={props.error !== undefined}
      validationBehavior="aria"
      {...(props.autoComplete === undefined ? {} : { autoComplete: props.autoComplete })}
      {...(props.inputMode === undefined ? {} : { inputMode: props.inputMode })}
      {...(props.maxLength === undefined ? {} : { maxLength: props.maxLength })}
      autoFocus={props.autoFocus ?? false}
    >
      <Label className={styles.label}>{props.label}</Label>
      <Input className={styles.input} spellCheck={false} />
      {props.help === undefined ? null : (
        <Text slot="description" className={styles.help}>
          {props.help}
        </Text>
      )}
      <FieldError className={styles.error}>{props.error}</FieldError>
    </TextField>
  );
}

export interface ButtonProps {
  readonly children: ReactNode;
  readonly variant?: "dark" | "primary" | "secondary" | "link";
  readonly type?: "button" | "submit";
  readonly onPress?: () => void;
  readonly isDisabled?: boolean;
}

/** A button: dark (Sign in), primary (accent), secondary, or one that reads as a link. */
export function Button(props: ButtonProps) {
  const variant = props.variant ?? "dark";
  const className = variant === "link" ? styles.link : `${styles.button} ${styles[variant]}`;
  return (
    <AriaButton
      className={className}
      type={props.type ?? "button"}
      isDisabled={props.isDisabled ?? false}
      {...(props.onPress === undefined ? {} : { onPress: props.onPress })}
    >
      {props.children}
    </AriaButton>
  );
}

/** A same-app link (the router's paths). */
export function TextLink(props: { readonly href: string; readonly children: ReactNode }) {
  return (
    <AriaLink className={styles.link} href={props.href}>
      {props.children}
    </AriaLink>
  );
}

/**
 * A note (DESIGN.md §6): amber warns, blue explains, green confirms. An
 * `alert` note is announced when it appears (errors after a submit).
 */
export function Note(props: {
  readonly tone: "amber" | "blue" | "green";
  readonly children: ReactNode;
  readonly alert?: boolean;
}) {
  return (
    <p
      className={`${styles.note} ${styles[props.tone]}`}
      {...(props.alert === true ? { role: "alert" } : {})}
    >
      {props.children}
    </p>
  );
}
