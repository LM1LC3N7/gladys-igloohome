// -----------------------------------------------------------------------------
// The texts shown to the user (feature names, connection status, action
// answers, command refusals, last command), in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });

/** The text of a `{ en, fr }` in a language (French when missing). */
export const word = (text, language) => text?.[language] ?? text?.fr ?? String(text ?? '');

/** `{ en, fr }` parts -> one text, for the status and the action answers. */
export const join = (...parts) => ({
  en: parts.map((p) => p.en).join(' '),
  fr: parts.map((p) => p.fr).join(' '),
});

/** A duration, rounded: "45 s", "12 min", "3 h". */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export const FEATURE_NAMES = {
  battery: both('Battery', 'Batterie'),
  syncAge: both('Hours since the last sync', 'Heures depuis la dernière synchro'),
  lock: both('Lock', 'Verrouiller'),
  unlock: both('Unlock', 'Déverrouiller'),
  lastCommand: both('Last command', 'Dernière commande'),
};

const ACTION_NAMES = {
  lock: both('Locking', 'Verrouillage'),
  unlock: both('Unlocking', 'Déverrouillage'),
};

/** The texts of the last-command feature: `(action) => { en, fr }`. */
export const LAST = {
  accepted: (action) =>
    both(
      `${ACTION_NAMES[action].en}: sent to the bridge, waiting for its confirmation (2 min at most).`,
      `${ACTION_NAMES[action].fr} : envoyé au bridge, en attente de sa confirmation (2 min au plus).`,
    ),
  done: (action) =>
    both(
      `${ACTION_NAMES[action].en}: job completed by the bridge.`,
      `${ACTION_NAMES[action].fr} : tâche terminée par le bridge.`,
    ),
  expired: (action) =>
    both(
      `${ACTION_NAMES[action].en}: not confirmed, the job expired (bridge out of reach, low battery?).`,
      `${ACTION_NAMES[action].fr} : non confirmé, la tâche a expiré (bridge hors de portée, pile faible ?).`,
    ),
  unconfirmed: (action, reason) =>
    both(
      `${ACTION_NAMES[action].en}: sent, without confirmation (${reason}).`,
      `${ACTION_NAMES[action].fr} : envoyé, sans confirmation (${reason}).`,
    ),
  refused: (action, reason) =>
    both(
      `${ACTION_NAMES[action].en}: refused by igloohome (${reason}), nothing done.`,
      `${ACTION_NAMES[action].fr} : refusé par igloohome (${reason}), rien n'a été fait.`,
    ),
};

export const T = {
  noCredentials: both(
    'Type the client id and the client secret of your iglooaccess API client in the configuration.',
    "Saisissez l'identifiant client (client id) et le secret client (client secret) de votre client API iglooaccess dans la configuration.",
  ),
  invalidCredentials: both(
    'The client id or the client secret holds spaces, a colon (id) or control characters, or is too long: not used.',
    "L'identifiant ou le secret client contient des espaces, un deux-points (identifiant) ou des caractères de contrôle, ou est trop long : non utilisés.",
  ),
  connecting: both('Connecting to igloohome…', 'Connexion à igloohome…'),
  connected: (summary) => join(both('Connected:', 'Connecté :'), summary),
  summary: (devices, commandable) =>
    both(
      `${devices} device(s), ${commandable} lock(s) commandable through a bridge.`,
      `${devices} appareil(s), ${commandable} serrure(s) commandable(s) par un bridge.`,
    ),
  morePages: both(
    'igloohome gave more devices on a further page, not read in this version.',
    "igloohome a donné d'autres appareils sur une page suivante, non lue dans cette version.",
  ),
  unlocking: (allowed) =>
    allowed
      ? both('Unlocking allowed.', 'Déverrouillage autorisé.')
      : both('Unlocking disabled.', 'Déverrouillage désactivé.'),
  paused: (wait) =>
    both(
      `igloohome asked to wait (HTTP 429 or 5xx): next read in ${wait}. Locking still gets one try.`,
      `igloohome a demandé d'attendre (HTTP 429 ou 5xx) : prochaine lecture dans ${wait}. Le verrouillage a encore droit à un essai.`,
    ),
  authRefused: (wait) =>
    both(
      `igloohome refused the client id or the client secret: check them in iglooaccess (next try in ${wait}, or at once after saving other ones, or with the test button).`,
      `igloohome a refusé l'identifiant ou le secret client : vérifiez-les dans iglooaccess (nouvel essai dans ${wait}, ou dès l'enregistrement d'autres identifiants, ou avec le bouton de test).`,
    ),
  scopeMissing: both(
    'The API client is not allowed what this integration needs (scopes get-devices, lock and unlock bridge jobs, get-job-status): give them to it in iglooaccess, then use the test button. No automatic new try.',
    "Le client API n'a pas les droits nécessaires à cette intégration (scopes get-devices, tâches bridge de verrouillage et déverrouillage, get-job-status) : donnez-les-lui dans iglooaccess, puis utilisez le bouton de test. Pas de nouvel essai automatique.",
  ),
  unreachable: (reason, wait) =>
    both(
      `igloohome did not answer usefully (${reason}); next try in ${wait}.`,
      `igloohome n'a pas répondu utilement (${reason}) ; nouvel essai dans ${wait}.`,
    ),
  test: {
    recent: (wait) =>
      both(
        `Read less than one refresh interval ago (next read in ${wait}). Last result:`,
        `Lu il y a moins d'un intervalle de rafraîchissement (prochaine lecture dans ${wait}). Dernier résultat :`,
      ),
    stillRefused: both(
      'The test did not succeed: the stop stays.',
      "Le test n'a pas réussi : l'arrêt reste.",
    ),
  },
};

/** The command refusals and errors (one language, the configured one). */
export const ERRORS = {
  readOnly: both('This feature cannot be controlled.', 'Cette fonctionnalité ne se commande pas.'),
  badValue: both('Invalid value: nothing sent.', "Valeur invalide : rien n'a été envoyé."),
  notConfigured: both(
    'igloohome is not configured (client id, client secret): nothing sent.',
    "igloohome n'est pas configuré (identifiant et secret client) : rien n'a été envoyé.",
  ),
  unknownDevice: both(
    'This lock is not known to the account of the configuration (or not read yet): nothing sent.',
    "Cette serrure n'est pas connue du compte de la configuration (ou pas encore lue) : rien n'a été envoyé.",
  ),
  unlockDisabled: both(
    'Unlocking is disabled in the configuration ("Allow unlocking"): nothing sent.',
    "Le déverrouillage est désactivé dans la configuration (« Autoriser le déverrouillage ») : rien n'a été envoyé.",
  ),
  cancelled: both(
    'Cancelled by a lock command: nothing sent.',
    "Annulée par une commande de verrouillage : rien n'a été envoyé.",
  ),
  tooSlow: both(
    'igloohome did not answer in time: nothing sent.',
    "igloohome n'a pas répondu à temps : rien n'a été envoyé.",
  ),
  blocked: both(
    'igloohome refused the credentials, or the API client lacks a scope: nothing sent.',
    "igloohome a refusé les identifiants, ou le client API n'a pas un des droits nécessaires : rien n'a été envoyé.",
  ),
  paused: (wait) =>
    both(
      `igloohome asked to wait (HTTP 429 or 5xx), ${wait} more: nothing sent.`,
      `igloohome a demandé d'attendre (HTTP 429 ou 5xx), encore ${wait} : rien n'a été envoyé.`,
    ),
  session: both(
    'The igloohome session is being renewed: nothing sent, try again in a few seconds.',
    "La session igloohome est en cours de renouvellement : rien n'a été envoyé, réessayez dans quelques secondes.",
  ),
  bridgeBusy: (wait) =>
    both(
      `The bridge of this lock got a job less than 30 s ago (it takes about 2 a minute): nothing sent, try again in ${wait}.`,
      `Le bridge de cette serrure a reçu une tâche il y a moins de 30 s (il en accepte environ 2 par minute) : rien n'a été envoyé, réessayez dans ${wait}.`,
    ),
  justCommanded: both(
    'An unlock of this lock is still waiting for its bridge (2 min at most): nothing sent.',
    "Un déverrouillage de cette serrure attend encore son bridge (2 min au plus) : rien n'a été envoyé.",
  ),
  unknownState: (reason) =>
    both(
      `This lock could not be read from igloohome just now (${reason}): nothing sent.`,
      `Cette serrure n'a pas pu être lue chez igloohome à l'instant (${reason}) : rien n'a été envoyé.`,
    ),
  notALock: both(
    'igloohome no longer lists this device as a lock of the account: nothing sent.',
    "igloohome ne liste plus cet appareil comme une serrure du compte : rien n'a été envoyé.",
  ),
  noBridge: both(
    'This lock is not linked to a bridge (igloohome commands a lock only through its bridge): nothing sent.',
    "Cette serrure n'est reliée à aucun bridge (igloohome ne commande une serrure que par son bridge) : rien n'a été envoyé.",
  ),
  notSent: (reason) => both(`Command not sent (${reason}).`, `Commande non envoyée (${reason}).`),
  refused: (reason) =>
    both(
      `igloohome refused the command (${reason}): nothing done.`,
      `igloohome a refusé la commande (${reason}) : rien n'a été fait.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): see "Last command" in a few minutes.`,
      `Commande envoyée, sans confirmation (${reason}) : voyez « Dernière commande » dans quelques minutes.`,
    ),
  accepted: both(
    'Command sent, without confirmation: igloohome accepted it, the bridge has 2 minutes to run it; see "Last command".',
    "Commande envoyée, sans confirmation : igloohome l'a acceptée, le bridge a 2 minutes pour l'exécuter ; voyez « Dernière commande ».",
  ),
};
