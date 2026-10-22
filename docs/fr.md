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
- **Dernière commande** : ce qu'igloohome dit de la tâche de la dernière
  commande (« acceptée, en attente du bridge », « tâche traitée par le bridge
  (résultat non lu) », « igloohome indique que la tâche a expiré », « résultat
  inconnu »…).

igloohome **ne donne pas l'état verrouillé/déverrouillé** d'une serrure :
l'intégration n'en invente pas (Home Assistant affiche un état supposé).

## Ce qu'il faut

1. Une ou plusieurs serrures igloohome appairées dans l'application igloohome,
   et un **bridge igloohome** pour les commander (sans bridge : batterie et
   synchro seulement).
2. Un **client API** créé dans le portail **iglooaccess** (offre plutôt
   destinée aux professionnels) : il donne un _client id_ et un _client
   secret_. Le client doit avoir les droits (scopes) `get-devices`,
   `lock-bridge-proxied-job` et `get-job-status`. Le droit
   `unlock-bridge-proxied-job` n'est nécessaire que si vous activez le
   déverrouillage ; sans lui, igloohome refuse lui-même tout déverrouillage
   (le reste fonctionne, le statut le dit). **igloohome peut facturer l'usage
   de l'API** (par exemple par appareil actif et par mois) : vérifiez les
   conditions de votre offre.

## Configuration

- **Identifiant client** et **Secret client** : ceux du client API. Le secret
  est gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à
  igloohome (`auth.igloohome.co`) pour obtenir un jeton d'accès. Le jeton reste
  en mémoire du conteneur, jamais écrit sur le disque.
- **Autoriser le déverrouillage des serrures depuis Gladys** : désactivé par
  défaut. Activé, une scène, un tableau de bord ou un assistant vocal relié à
  Gladys peut ouvrir votre porte. Le jeton n'a le droit de déverrouiller que
  lorsque l'option est activée (un nouveau jeton est demandé quand vous la
  changez).
- **Intervalle de rafraîchissement** : 900 s (15 min) par défaut, de 300 s à
  86 400 s. Une seule requête par lecture pour tout le compte.
- **Langue des noms des fonctionnalités**.

Enregistrez, puis ajoutez les appareils depuis l'onglet **Découverte**.

## Les commandes et leur sécurité

igloohome commande une serrure **par son bridge**, sous forme d'une « tâche »
que le bridge exécute plus tard (il en accepte environ 2 par minute). **Une
tâche déjà acceptée par igloohome ne peut pas être annulée**, et l'ordre
d'exécution des tâches par le bridge n'est pas garanti.

- **Déverrouiller** est refusé tant que l'option n'est pas activée ; l'option
  est revérifiée à l'arrivée, après la lecture et juste avant l'envoi. Avant
  d'agir, la liste des appareils est **relue chez igloohome** : la serrure
  doit y être encore, comme serrure, reliée à un bridge. Un seul
  déverrouillage à la fois par serrure ; aucun autre tant que la tâche du
  précédent est suivie (jusqu'à sa fin, 15 min au plus, gardé même après un
  redémarrage) ; aucun dans les 30 s d'une autre tâche sur le même bridge.
- **Verrouiller** n'est jamais bloqué : pas de lecture avant, pas de file
  d'attente, un essai même pendant une pause demandée par igloohome ou un
  arrêt, et possible dès le redémarrage (le bridge de chaque serrure est gardé
  dans `/data`). Il annule aussitôt tout déverrouillage de cette serrure pas
  encore envoyé.
- Une commande part dans les 3,5 s de votre clic, sinon elle est refusée sans
  rien envoyer. Elle n'est **jamais annoncée réussie** : une tâche acceptée
  par igloohome est « Commande envoyée, sans confirmation ». Son état est
  ensuite relu (5, 15, 30, 60, 100, 140 s, puis chaque minute) jusqu'à ce
  qu'igloohome la dise traitée, ou expirée (son heure à elle, l'en-tête `Date`
  de sa réponse, après la date d'expiration : jamais l'horloge de Gladys), ou
  15 min au plus (alors « résultat inconnu : vérifiez la serrure »). Ce
  qu'igloohome dit du résultat d'une tâche traitée n'est pas encore lu (forme
  inconnue) : vérifiez la serrure.
- Si un déverrouillage envoyé **avant** un verrouillage est aussi traité, quel
  que soit l'ordre, **Dernière commande** le signale jusqu'à la commande
  suivante (même après un redémarrage) : vérifiez la serrure et appuyez de
  nouveau sur Verrouiller (jamais de renvoi automatique).
- Les boutons ne sont jamais des interrupteurs : un « tout éteindre » d'un
  assistant vocal ou d'une scène ne peut pas les atteindre.

## Erreurs et limites de débit

- **Identifiants refusés ou droits manquants** (tout refus du point de jeton
  hors 429/5xx) : arrêt définitif gardé dans `/data`, **sans nouvel essai
  automatique**. Il est levé par l'enregistrement d'autres identifiants, ou
  par un succès du bouton **Tester la connexion** (qui réessaie une fois).
- **HTTP 429 ou 5xx** : pause de 1 min à 6 h gardée dans `/data` (le
  verrouillage a encore droit à un essai). Un 5xx sur l'état d'une tâche
  saute seulement cette lecture.
- Autres erreurs : nouvel essai à l'intervalle (5 min au moins). Le bouton de
  test (sauf lu il y a moins d'un intervalle), la Découverte, une reconnexion
  à Gladys ou un redémarrage ne relisent jamais plus vite que l'intervalle.
- Après un redémarrage, la dernière lecture réussie gardée dans `/data`
  donne aussitôt l'onglet Découverte, et le statut « connecté » et les badges
  si la dernière lecture avant le redémarrage avait réussi (sinon le statut le
  dit), jusqu'à la lecture suivante (ses valeurs ne sont pas republiées comme
  neuves). Une commande dont le suivi a pris fin pendant l'arrêt affiche
  « résultat inconnu ».

## Ce qui est gardé dans `/data`

Le fichier `igloohome-state.json` (lisible seulement par l'utilisateur du
conteneur) garde : les pauses, les arrêts (avec l'empreinte salée des
identifiants **refusés**, jamais des bons), l'heure de la dernière lecture et
de la dernière réussite, un résumé borné de la liste des appareils (noms,
types, batterie, synchro, bridge), les identifiants igloohome des serrures et
de leurs bridges, les tâches suivies et les gardes de déverrouillage (écrites
aussitôt après l'envoi). Jamais le secret ni le jeton.

## Limites connues

- Pas d'état verrouillé/déverrouillé (l'API n'en donne pas sans une tâche du
  bridge), pas de journal des accès ni de code PIN dans cette version.
- Seule la première page de la liste des appareils est lue (un message le dit
  si igloohome en donne d'autres).
- Le sens exact d'une tâche « traitée » (réussie ou seulement finie) et sa
  durée de vie restent à vérifier sur un vrai compte.

## Crédits

Logique portée de [igloohome-api](https://github.com/keithle888/igloohome-api)
(MIT) et de l'intégration igloohome de Home Assistant (Apache-2.0) : voir
`THIRD_PARTY_NOTICES.md`.
