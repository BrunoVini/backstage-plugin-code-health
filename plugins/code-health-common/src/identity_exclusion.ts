/**
 * Why an account stops counting towards anybody's figures.
 *
 * A closed set rather than free text. The reason is the whole justification for
 * a row disappearing from every table in the plugin, and "removed by Felipe,
 * June" is not one anybody can audit six months later. Four reasons cover what
 * actually turns up in a fleet, and each of them answers a different question
 * about the row: whether the human left, whether they were ever in the
 * organisation, whether there is a human at all, and whether the platform
 * itself is acting.
 */
export type ExclusionReason =
  | "former-contributor"
  | "open-source-contributor"
  | "automated-bot"
  | "service-account";

export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "former-contributor",
  "open-source-contributor",
  "automated-bot",
  "service-account",
];

export const isExclusionReason = (value: unknown): value is ExclusionReason =>
  typeof value === "string" && (EXCLUSION_REASONS as readonly string[]).includes(value);

/** What the chip and the menu entry say. */
export const EXCLUSION_REASON_LABELS: Readonly<Record<ExclusionReason, string>> = {
  "former-contributor": "Former contributor",
  "open-source-contributor": "Open source contributor",
  "automated-bot": "Automated bot",
  "service-account": "Service or system account",
};

/** The sentence under each menu entry, so the choice is made on purpose. */
export const EXCLUSION_REASON_DESCRIPTIONS: Readonly<Record<ExclusionReason, string>> = {
  "former-contributor":
    "Somebody who has left. Their work stays in the database, and stops counting towards anybody's figures.",
  "open-source-contributor":
    "An outside contributor to a public repository, who is not a member of the organisation being measured.",
  "automated-bot":
    "A bot that commits, opens pull requests or votes on them under its own account.",
  "service-account":
    "An identity the platform itself acts as — an Azure DevOps build service, a deployment principal.",
};
