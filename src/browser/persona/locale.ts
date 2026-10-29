// The timezone and language a persona presents: those of the country its
// browser exits through. A site compares them with the exit's geography, so a
// persona whose locale disagrees with its exit is the mismatch fraud checks
// look for. The country is the one the proxy exit reports, else the one the
// run states in WELES_PERSONA_COUNTRY; a run that names neither, or a country
// the table below does not hold, is refused by name instead of being given one.

/** Where a run states the country it exits from when no proxy exit reports one. */
export const STATED_PERSONA_COUNTRY = 'WELES_PERSONA_COUNTRY';

const COUNTRY_LOCALE: Record<string, { timezone: string; language: string }> = {
  US: { timezone: 'America/New_York', language: 'en-US' },
  UK: { timezone: 'Europe/London', language: 'en-GB' },
  GB: { timezone: 'Europe/London', language: 'en-GB' },
  DE: { timezone: 'Europe/Berlin', language: 'de-DE' },
  FR: { timezone: 'Europe/Paris', language: 'fr-FR' },
  NL: { timezone: 'Europe/Amsterdam', language: 'nl-NL' },
  CA: { timezone: 'America/Toronto', language: 'en-CA' },
  AU: { timezone: 'Australia/Sydney', language: 'en-AU' },
};

/** What the run knows about where its browser exits: the exit's country and, when observed, its timezone. */
export interface ExitGeography {
  country: string | undefined;
  timezone?: string;
}

export interface PersonaLocale {
  country: string;
  timezone: string;
  language: string;
}

/**
 * The locale of a persona exiting at `exit`: the observed exit timezone when
 * the exit reported one, else the country's own, and the country's language.
 */
export function personaLocale(exit: ExitGeography): PersonaLocale {
  const stated =
    exit.country?.trim() || process.env[STATED_PERSONA_COUNTRY]?.trim();
  if (!stated)
    throw new Error(
      `persona_country_unknown: the run reports no proxy exit country and ${STATED_PERSONA_COUNTRY} is not set; a persona's timezone and language follow the country its browser exits from, and none is assumed`,
    );
  const country = stated.toUpperCase();
  const locale = COUNTRY_LOCALE[country];
  if (!locale)
    throw new Error(
      `persona_country_unsupported: ${country} has no persona locale; the locales held are ${Object.keys(COUNTRY_LOCALE).join(', ')}`,
    );
  return {
    country,
    timezone: exit.timezone?.trim() || locale.timezone,
    language: locale.language,
  };
}
