# igloohome pour Gladys Assistant

Cette intégration amène dans Gladys les appareils igloohome de votre compte
(serrures, cadenas, boîtes à clés, claviers) par l'**API officielle igloohome**
(igloodeveloper), celle qu'utilise Home Assistant.

> Intégration non officielle, **sans lien avec igloohome**.
>
> Jamais testé avec un vrai appareil ni un vrai compte : seulement contre un
> faux serveur igloohome dans les tests. Vos retours sont bienvenus.

## Ce que vous obtenez

Pour chaque appareil du compte (les bridges ne sont pas affichés) :

- **Batterie** (%), quand igloohome la donne ;
- **Heures depuis la dernière synchro** : l'âge de la dernière synchronisation
  de l'appareil avec igloohome (utile pour une scène « serrure muette depuis
  48 h »).

Et pour une **serrure reliée à un bridge** :

- un bouton **Verrouiller** (toujours permis) ;
- un bouton **Déverrouiller** (désactivé par défaut, voir plus bas) ;
- **Dernière commande** : le résultat de la dernière commande, relu chez
  igloohome (« tâche terminée par le bridge », « non confirmé, la tâche a
  expiré »…).

igloohome **ne donne pas l'état verrouillé/déverrouillé** d'une serrure :
l'intégration n'en invente pas (Home Assistant affiche un état supposé).

## Ce qu'il faut

1. Une ou plusieurs serrures igloohome appairées dans l'application igloohome,
   et un **bridge igloohome** pour les commander (sans bridge : batterie et
   synchro seulement).
2. Un **client API** créé dans le portail **iglooaccess** (offre plutôt
   destinée aux professionnels) : il donne un _client id_ et un _client
   secret_. Le client doit avoir les droits (scopes) `get-devices`,
   `lock-bridge-proxied-job`, `unlock-bridge-proxied-job` et `get-job-status`.
   **igloohome peut facturer l'usage de l'API** (par exemple par appareil
   actif et par mois) : vérifiez les conditions de votre offre.

## Configuration

- **Identifiant client** et **Secret client** : ceux du client API. Le secret
  est gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à
  igloohome (`auth.igloohome.co`) pour obtenir un jeton d'accès. Le jeton reste
  en mémoire du conteneur, jamais écrit sur le disque.
- **Autoriser le déverrouillage des serrures depuis Gladys** : désactivé par
  défaut. Activé, une scène, un tableau de bord ou un assistant vocal relié à
  Gladys peut ouvrir votre porte.
- **Intervalle de rafraîchissement** : 900 s (15 min) par défaut, de 300 s à
  86 400 s. Une seule requête par lecture pour tout le compte.
- **Langue des noms des fonctionnalités**.

Enregistrez, puis ajoutez les appareils depuis l'onglet **Découverte**.

## Les commandes et leur sécurité

igloohome commande une serrure **par son bridge**, sous forme d'une « tâche »
que le bridge exécute dans les 2 minutes (il en accepte environ 2 par minute).

- **Déverrouiller** est refusé tant que l'option n'est pas activée ; l'option
  est revérifiée à l'arrivée, après la lecture et juste avant l'envoi. Avant
  d'agir, la liste des appareils est **relue chez igloohome** : la serrure
  doit y être encore, comme serrure, reliée à un bridge. Un seul
  déverrouillage à la fois par serrure ; aucun autre tant que le précédent
  peut encore attendre son bridge (2 min 30, gardé même après un
  redémarrage) ; aucun dans les 30 s d'une autre tâche sur le même bridge.
- **Verrouiller** n'est jamais bloqué : pas de lecture avant, pas de file
  d'attente, un essai même pendant une pause demandée par igloohome, et
  possible dès le redémarrage (le bridge de chaque serrure est gardé dans
  `/data`). Il annule aussitôt tout déverrouillage de cette serrure pas encore
  envoyé.
- Une commande part dans les 3,5 s de votre clic, sinon elle est refusée sans
  rien envoyer. Une tâche acceptée par igloohome est annoncée « Commande
  envoyée, sans confirmation » : la confirmation vient ensuite de l'état de la
  tâche, relu plusieurs fois pendant 2 min 20, et s'affiche dans **Dernière
  commande**. Si la tâche est déjà terminée à la réponse, la commande est
  confirmée tout de suite.
- Les boutons ne sont jamais des interrupteurs : un « tout éteindre » d'un
  assistant vocal ou d'une scène ne peut pas les atteindre.

## Erreurs et limites de débit

- **Identifiants refusés** : arrêt gardé dans `/data`, nouvel essai dans 1 h,
  6 h puis toutes les 24 h ; aussitôt avec d'autres identifiants ; le bouton
  **Tester la connexion** réessaie une fois et ne lève l'arrêt qu'en cas de
  succès.
- **Droits (scopes) manquants** : arrêt définitif, sans nouvel essai
  automatique, jusqu'au bouton de test ou d'autres identifiants.
- **HTTP 429 ou 5xx** : pause de 1 min à 6 h gardée dans `/data` (le
  verrouillage a encore droit à un essai).
- Autres erreurs : nouvel essai dans 1, 2, 5 puis 15 min, jamais plus vite que
  l'intervalle. Le bouton de test, la Découverte, une reconnexion à Gladys ou
  un redémarrage ne relisent jamais plus vite que l'intervalle.

## Ce qui est gardé dans `/data`

Le fichier `igloohome-state.json` (lisible seulement par l'utilisateur du
conteneur) garde : les pauses, les arrêts (avec l'empreinte salée des
identifiants **refusés**, jamais des bons), l'heure de la dernière lecture,
les identifiants igloohome des serrures et de leurs bridges, les gardes de
déverrouillage. Jamais le secret ni le jeton.

## Limites connues

- Pas d'état verrouillé/déverrouillé (l'API n'en donne pas sans une tâche du
  bridge), pas de journal des accès ni de code PIN dans cette version.
- Seule la première page de la liste des appareils est lue (un message le dit
  si igloohome en donne d'autres).
- La signification exacte de « tâche terminée » (réussie ou seulement finie)
  reste à vérifier sur un vrai compte.

## Crédits

Logique portée de [igloohome-api](https://github.com/keithle888/igloohome-api)
(MIT) et de l'intégration igloohome de Home Assistant (Apache-2.0) : voir
`THIRD_PARTY_NOTICES.md`.
