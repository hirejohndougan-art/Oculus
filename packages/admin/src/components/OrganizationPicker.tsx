/**
 * "Which organization do you want to work in?" after a right code, for a
 * person in several (D-019: a session works in exactly one). Radio choice
 * cards (DESIGN.md §6).
 */
import { Label, RadioButton, RadioField, RadioGroup } from "react-aria-components";
import type { OrganizationChoice } from "../types";
import styles from "./OrganizationPicker.module.css";

export function OrganizationPicker(props: {
  readonly organizations: readonly OrganizationChoice[];
  readonly value: string | undefined;
  readonly onChange: (organizationId: string) => void;
}) {
  return (
    <RadioGroup
      className={styles.group}
      value={props.value ?? null}
      onChange={props.onChange}
      isRequired
    >
      <Label className={styles.label}>Which organization do you want to work in?</Label>
      {props.organizations.map((o) => (
        <RadioField key={o.organizationId} value={o.organizationId}>
          <RadioButton className={styles.choice}>
            <span className={styles.dot} aria-hidden="true" />
            {o.name}
          </RadioButton>
        </RadioField>
      ))}
    </RadioGroup>
  );
}
