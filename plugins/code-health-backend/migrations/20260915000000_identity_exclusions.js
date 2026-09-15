// @ts-check

/**
 * The accounts that are measured by nothing, and why.
 *
 * A separate table from `code_health_identity_links` rather than a column on
 * it, because the two answer different questions and an account routinely has
 * one without the other: a build service is excluded and linked to nobody, and
 * a leaver is linked to a catalog user and excluded. Folding them together
 * would make excluding somebody require inventing a link, or unlinking somebody
 * silently measure them again.
 *
 * Nothing is deleted when a row is written here. The events, the snapshots and
 * the per-source measures all stay exactly as they were collected, and the
 * exclusion is applied when a row is built — which is what makes including an
 * account again restore every window that was ever collected, rather than only
 * the ones collected afterwards. It is the same rule the link table follows,
 * for the same reason.
 *
 * Only portable Knex builders are used, so the same migration runs on the
 * better-sqlite3 database a default Backstage install uses and on the
 * PostgreSQL a production one uses.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('code_health_identity_exclusions', table => {
    table.string('source', 32).notNullable();
    // Normalised the same way `code_health_identities.source_key` is: trimmed
    // and lowercased, because that is the key an exclusion has to match.
    table.string('source_key', 320).notNullable();
    // One of the four reasons the wire contract names. Stored rather than
    // derived: a row disappearing from every table is only reviewable later if
    // the justification was recorded at the moment somebody made the decision.
    table.string('reason', 32).notNullable();
    table.string('excluded_by', 512).nullable();
    table.datetime('excluded_at').notNullable();

    // Not a foreign key onto `code_health_identities`, for the same reason the
    // link table is not one: losing the exclusion when an account ages out
    // would silently put a build service back into everybody's figures.
    table.primary(['source', 'source_key']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('code_health_identity_exclusions');
};
