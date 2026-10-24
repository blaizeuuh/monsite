<?php
/**
 * formulaire.php — Réception sécurisée du formulaire de contact « Mon Site »
 * ============================================================================
 * Compatible PHP 7.4 → 8.x. Aucune dépendance. Envoi par la fonction mail().
 *
 * Deux usages (réponses toujours en JSON) :
 *   GET  formulaire.php?action=token   → délivre un jeton signé (valable 2 h)
 *   POST formulaire.php (JSON)         → valide, filtre le spam, envoie l'e-mail
 *
 * PROTECTIONS INTÉGRÉES
 *   • Jeton signé HMAC-SHA256 : durée de vie limitée, UN SEUL usage (anti-rejeu),
 *     délai minimum de remplissage (les robots envoient en quelques millisecondes)
 *   • Honeypot : champ invisible « website ». Rempli = robot → faux « succès »
 *     renvoyé pour ne pas l'alerter, rien n'est envoyé
 *   • Limitation de débit par IP (empreinte HMAC, jamais l'IP en clair) + plafond
 *     global quotidien : protège ta boîte mail d'une inondation
 *   • Anti-CSRF : Content-Type JSON obligatoire (impossible via un <form> externe),
 *     contrôle des en-têtes Origin / Sec-Fetch-Site, aucun CORS ouvert
 *   • Validation stricte (listes blanches), taille de requête limitée, limite de
 *     liens (spam), HTML/BBCode refusés
 *   • Destinataire FIXÉ ICI : jamais lu depuis la requête → impossible d'utiliser
 *     ce script comme relais de spam
 *   • Anti-injection d'en-têtes e-mail (CR/LF) ; e-mail en texte brut (pas de XSS
 *     dans la messagerie)
 *   • Erreurs PHP jamais affichées (uniquement journalisées), en-têtes de sécurité
 *
 * MISE EN ROUTE : modifie uniquement le bloc CONFIGURATION ci-dessous.
 * ⚠ Enregistre ce fichier en UTF-8 SANS BOM (un BOM avant « <?php » casse
 *   declare(strict_types) et les en-têtes HTTP). Dans VS Code : « UTF-8 » (et non « UTF-8 with BOM »).
 * ============================================================================ */

declare(strict_types=1);

/* =============================== CONFIGURATION =============================== */

// Adresse qui REÇOIT les messages (jamais lue depuis le formulaire)
const CONTACT_TO = 'contact@example.com';

// Expéditeur technique. Utilise une adresse de TON nom de domaine (SPF/DKIM) :
// c'est ce qui évite que les messages finissent dans les courriers indésirables.
// Le visiteur, lui, est en « Répondre à » : tu réponds directement depuis ta messagerie.
const MAIL_FROM = 'no-reply@example.com';

const SITE_NAME = 'Mon Site';

// Secret de signature des jetons (32 caractères minimum). Laisse vide : il est alors
// généré automatiquement et stocké hors du dossier public.
const SECRET_KEY = '';

// Dossier PRIVÉ accessible en écriture (compteurs anti-abus, jetons déjà utilisés, secret auto-généré).
// Vide = dossier temporaire du système (inaccessible depuis Internet, convient presque partout).
// Si le formulaire répond « temporairement indisponible », indique ici un dossier situé HORS du
// dossier public de ton hébergement (ex. '/home/identifiant/monsite-data') et crée-le.
const STORAGE_DIR = '';

// Hôtes supplémentaires acceptés pour le contrôle d'origine (en plus du domaine courant),
// ex. ['www.mon-domaine.fr']. Utile si un proxy modifie l'en-tête Host.
const ALLOWED_HOSTS = [];

// '' = adresse IP vue par PHP (REMOTE_ADDR). Derrière Cloudflare : 'HTTP_CF_CONNECTING_IP'.
// À ne renseigner QUE si tu es réellement derrière ce proxy (sinon l'en-tête serait falsifiable).
const TRUSTED_IP_HEADER = '';

// true si ton hébergeur exige l'option -f de mail() (adresse d'enveloppe = MAIL_FROM)
const ENVELOPE_FROM = false;

/* ----- Réglages anti-abus (les valeurs par défaut conviennent à un site vitrine) ----- */
const MIN_FILL_SECONDS = 3;          // délai minimum entre la demande du jeton et l'envoi
const TOKEN_TTL        = 7200;       // validité d'un jeton (secondes)
const MAX_BODY_BYTES   = 16384;      // taille maximale d'une requête
const LIMIT_ATTEMPTS   = [15, 600];  // [maximum, fenêtre en s] : requêtes POST par IP
const LIMIT_TOKENS     = [60, 3600]; // jetons demandés par IP
const LIMIT_SENT_IP    = [3, 3600];  // messages envoyés par IP
const LIMIT_SENT_ALL   = [60, 86400];// messages envoyés au total par jour

/* ============================ FIN DE LA CONFIGURATION ============================ */


/* ---------------------------- Durcissement général ---------------------------- */
ini_set('display_errors', '0');      // jamais d'erreur affichée au visiteur
ini_set('log_errors', '1');
error_reporting(E_ALL);
date_default_timezone_set('Europe/Paris');
header_remove('X-Powered-By');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
header('Referrer-Policy: no-referrer');
header('Cross-Origin-Resource-Policy: same-origin');

set_exception_handler(static function (Throwable $e): void {
    error_log('[monsite-contact] ' . get_class($e) . ' : ' . $e->getMessage());
    fail(500, 'server', 'Erreur du serveur. Merci de réessayer un peu plus tard.');
});


/* ================================= Utilitaires ================================= */

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(int $status, string $code, string $message, array $extra = []): void
{
    respond($status, ['ok' => false, 'code' => $code, 'message' => $message] + $extra);
}

function text_length(string $s): int
{
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : (int) preg_match_all('/./su', $s);
}

function b64url(string $raw): string
{
    return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

function b64url_decode(string $text): string
{
    $text = strtr($text, '-_', '+/');
    $decoded = base64_decode($text . str_repeat('=', (4 - strlen($text) % 4) % 4), true);
    return $decoded === false ? '' : $decoded;
}

/* En-tête MIME : ASCII tel quel, sinon encodé en UTF-8 (jamais de CR/LF) */
function mime_header(string $text): string
{
    $text = trim((string) preg_replace('/[\r\n]+/', ' ', $text));
    return preg_match('/^[\x20-\x7E]*$/', $text) ? $text : '=?UTF-8?B?' . base64_encode($text) . '?=';
}


/* ====================== Stockage privé (hors dossier public) ====================== */

/**
 * Dossier de travail : compteurs de limitation, jetons déjà utilisés, secret auto-généré.
 * Par défaut dans le dossier temporaire du système, donc inaccessible depuis Internet
 * (voir STORAGE_DIR pour le changer).
 */
function storage_dir(): ?string
{
    static $dir = false;
    if ($dir !== false) {
        return $dir;
    }
    $path = STORAGE_DIR !== ''
        ? rtrim(STORAGE_DIR, '/\\')
        : rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'monsite-' . substr(hash('sha256', __DIR__), 0, 12);
    if (!is_dir($path) && !@mkdir($path, 0700, true) && !is_dir($path)) {
        error_log('[monsite-contact] dossier de travail indisponible : ' . $path);
        return $dir = null;
    }
    return $dir = $path;
}

function secret(): string
{
    static $key = null;
    if ($key !== null) {
        return $key;
    }
    if (strlen(SECRET_KEY) >= 32) {
        return $key = SECRET_KEY;
    }
    $dir = storage_dir();
    if ($dir === null) {
        error_log('[monsite-contact] définis SECRET_KEY (32+ caractères) : aucun stockage disponible');
        fail(500, 'config', 'Le formulaire est temporairement indisponible.');
    }
    $file = $dir . DIRECTORY_SEPARATOR . 'secret.key';
    $handle = @fopen($file, 'x');                      // création atomique : un seul gagnant
    if ($handle) {
        fwrite($handle, bin2hex(random_bytes(32)));
        fclose($handle);
        @chmod($file, 0600);
    }
    $value = trim((string) @file_get_contents($file));
    if (strlen($value) < 64) {
        error_log('[monsite-contact] secret illisible : ' . $file);
        fail(500, 'config', 'Le formulaire est temporairement indisponible.');
    }
    return $key = $value;
}

/** Nettoyage occasionnel (1 requête sur 50) des fichiers de plus de 2 jours */
function garbage_collect(): void
{
    if (mt_rand(1, 50) !== 1 || ($dir = storage_dir()) === null) {
        return;
    }
    $limit = time() - 2 * 86400;
    foreach ((array) @scandir($dir) as $name) {
        if (strpos((string) $name, 'rl_') === 0 || strpos((string) $name, 'n_') === 0) {
            $file = $dir . DIRECTORY_SEPARATOR . $name;
            if ((int) @filemtime($file) < $limit) {
                @unlink($file);
            }
        }
    }
}


/* ========================== Adresse IP & limitation de débit ========================== */

/** Empreinte HMAC de l'IP (IPv6 : réseau /64, sinon il suffirait de changer d'adresse) */
function client_key(): string
{
    $raw = TRUSTED_IP_HEADER !== '' && !empty($_SERVER[TRUSTED_IP_HEADER])
        ? trim(explode(',', (string) $_SERVER[TRUSTED_IP_HEADER])[0])
        : (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $ip = filter_var($raw, FILTER_VALIDATE_IP) ? $raw : '0.0.0.0';
    $packed = @inet_pton($ip);
    if ($packed !== false && strlen($packed) === 16) {
        $ip = bin2hex(substr($packed, 0, 8));
    }
    return substr(hash_hmac('sha256', $ip, secret()), 0, 24);
}

/**
 * Fenêtre glissante. Retourne true si la limite n'est pas atteinte.
 * $consume = true enregistre l'événement ; false se contente de vérifier.
 * Si le stockage est indisponible on laisse passer (les autres protections restent actives).
 */
function rate_ok(string $bucket, array $limit, bool $consume = true): bool
{
    [$max, $window] = $limit;
    $dir = storage_dir();
    if ($dir === null) {
        return true;
    }
    $file = $dir . DIRECTORY_SEPARATOR . 'rl_' . substr(hash_hmac('sha256', $bucket, secret()), 0, 32);
    $handle = @fopen($file, 'c+');
    if (!$handle) {
        return true;
    }
    flock($handle, LOCK_EX);
    $stored = json_decode((string) stream_get_contents($handle), true);
    $now = time();
    $events = array_values(array_filter(is_array($stored) ? $stored : [], static function ($t) use ($now, $window) {
        return is_int($t) && $t > $now - $window;
    }));
    $allowed = count($events) < $max;
    if ($allowed && $consume) {
        $events[] = $now;
    }
    rewind($handle);
    ftruncate($handle, 0);
    fwrite($handle, (string) json_encode($events));
    flock($handle, LOCK_UN);
    fclose($handle);
    return $allowed;
}


/* ================================ Jetons signés ================================ */

function issue_token(): string
{
    $payload = b64url((string) json_encode(['i' => time(), 'n' => bin2hex(random_bytes(12))]));
    return $payload . '.' . b64url(hash_hmac('sha256', $payload, secret(), true));
}

/** @return array{i:int,n:string}|null */
function verify_token(string $token): ?array
{
    $parts = explode('.', $token);
    if (count($parts) !== 2 || strlen($token) > 400) {
        return null;
    }
    $expected = b64url(hash_hmac('sha256', $parts[0], secret(), true));
    if (!hash_equals($expected, $parts[1])) {
        return null;
    }
    $data = json_decode(b64url_decode($parts[0]), true);
    if (!is_array($data) || !isset($data['i'], $data['n']) || !is_int($data['i']) || !is_string($data['n'])
        || !preg_match('/^[a-f0-9]{24}$/', $data['n'])) {
        return null;
    }
    return ['i' => $data['i'], 'n' => $data['n']];
}

/** Marque le jeton comme utilisé (atomique). false = déjà utilisé → rejeu refusé. */
function claim_nonce(string $nonce): bool
{
    $dir = storage_dir();
    if ($dir === null) {
        return true;
    }
    $file = $dir . DIRECTORY_SEPARATOR . 'n_' . hash('sha256', $nonce);
    $handle = @fopen($file, 'x');
    if ($handle) {
        fclose($handle);
        return true;
    }
    return !file_exists($file);        // l'échec venait d'un problème d'écriture, pas d'un rejeu
}

function release_nonce(string $nonce): void
{
    $dir = storage_dir();
    if ($dir !== null) {
        @unlink($dir . DIRECTORY_SEPARATOR . 'n_' . hash('sha256', $nonce));
    }
}


/* ============================ Contrôles de la requête ============================ */

/** Anti-CSRF : la requête doit provenir de ce site (Origin, sinon Sec-Fetch-Site) */
function check_origin(): void
{
    $host = strtolower((string) preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
    if ($host === '') {
        fail(400, 'host', 'Requête invalide.');
    }
    $allowed = array_merge([$host], array_map('strtolower', ALLOWED_HOSTS));

    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin !== '') {
        $originHost = parse_url($origin, PHP_URL_HOST);
        if (!is_string($originHost) || !in_array(strtolower($originHost), $allowed, true)) {
            fail(403, 'origin', 'Origine non autorisée.');
        }
        return;
    }
    $site = strtolower((string) ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? ''));
    if ($site !== '' && $site !== 'same-origin' && $site !== 'none') {
        fail(403, 'origin', 'Origine non autorisée.');
    }
}

/** Corps JSON obligatoire (un <form> externe ne peut pas envoyer ce type sans pré-vérification CORS) */
function read_json(): array
{
    $type = strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? ''));
    if (strpos($type, 'application/json') !== 0) {
        // Navigation directe (formulaire envoyé sans JavaScript) : message lisible plutôt que du JSON brut
        if (($_SERVER['HTTP_SEC_FETCH_DEST'] ?? '') === 'document') {
            http_response_code(415);
            header('Content-Type: text/html; charset=utf-8');
            echo '<!doctype html><meta charset="utf-8"><title>JavaScript requis</title>'
               . '<p style="font:16px/1.5 system-ui;margin:3rem auto;max-width:32rem;padding:0 1rem">'
               . 'Le formulaire nécessite JavaScript (protection anti-spam). Activez-le puis '
               . '<a href="./#contact">retournez au formulaire</a>.</p>';
            exit;
        }
        fail(415, 'type', 'Type de contenu non pris en charge.');
    }
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_BODY_BYTES) {
        fail(413, 'size', 'Requête trop volumineuse.');
    }
    $raw = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
    if ($raw === false || $raw === '') {
        fail(400, 'invalid', 'Requête vide.');
    }
    if (strlen($raw) > MAX_BODY_BYTES) {
        fail(413, 'size', 'Requête trop volumineuse.');
    }
    $data = json_decode($raw, true, 4);
    if (!is_array($data)) {
        fail(400, 'invalid', 'Requête invalide.');
    }
    return $data;
}


/* ================================== Validation ================================== */

const PLANS = [
    'type-a' => ['label' => 'Site Type A — 700 €',   'ascii' => 'Site Type A (700 EUR)'],
    'type-b' => ['label' => 'Site Type B — 1 000 €', 'ascii' => 'Site Type B (1000 EUR)'],
    'autre'  => ['label' => 'Autre / Question',      'ascii' => 'Autre / Question'],
];

/** Texte sur une seule ligne : UTF-8 valide, sans caractères de contrôle, espaces normalisés */
function clean_line($value): string
{
    if (!is_string($value) || preg_match('//u', $value) !== 1) {
        return '';
    }
    $value = (string) preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value);
    return trim((string) preg_replace('/\s+/u', ' ', $value));
}

/** Texte multi-lignes : sauts de ligne conservés, caractères de contrôle supprimés */
function clean_text($value): string
{
    if (!is_string($value) || preg_match('//u', $value) !== 1) {
        return '';
    }
    $value = str_replace(["\r\n", "\r"], "\n", $value);
    $value = (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value);
    return trim((string) preg_replace("/\n{3,}/", "\n\n", $value));
}

/** @return array{0:array,1:array} [données propres, erreurs par champ] */
function validate(array $in): array
{
    $errors = [];
    $name = clean_line($in['name'] ?? '');
    $email = strtolower(clean_line($in['email'] ?? ''));
    $plan = is_string($in['plan'] ?? null) ? $in['plan'] : '';
    $hosting = !empty($in['hosting']) && $in['hosting'] !== 'false';
    $message = clean_text($in['message'] ?? '');

    // Nom : lettres, chiffres, espaces et . , ' ’ & - (même règle que le navigateur)
    $nameLen = text_length($name);
    if ($nameLen < 2) {
        $errors['name'] = 'Indiquez votre nom.';
    } elseif ($nameLen > 80 || !preg_match('/^[\p{L}\p{M}][\p{L}\p{M}\p{Nd} .,\'’&-]{1,79}$/u', $name)
        || preg_match('~(https?:|www\.|\.[a-z]{2,}/)~i', $name)) {
        $errors['name'] = 'Ce nom contient des caractères non autorisés.';
    }

    if ($email === '' || strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', $email)) {
        $errors['email'] = 'Cette adresse e-mail semble incorrecte.';
    }

    if (!array_key_exists($plan, PLANS)) {
        $errors['plan'] = 'Choisissez une formule dans la liste.';
    }

    $messageLen = text_length($message);
    if ($messageLen < 10) {
        $errors['message'] = 'Votre message est un peu court (10 caractères minimum).';
    } elseif ($messageLen > 2000) {
        $errors['message'] = 'Votre message est trop long (2 000 caractères maximum).';
    } elseif (preg_match_all('~(?:https?://|www\.)~i', $message) > 2
        || preg_match('~<\s*/?\s*[a-z][^>]*>|\[/?(?:url|link|img)\b~i', $message)) {
        $errors['message'] = 'Merci de retirer le HTML et de limiter le message à 2 liens maximum.';
    }

    return [compact('name', 'email', 'plan', 'hosting', 'message'), $errors];
}


/* ================================ Envoi de l'e-mail ================================ */

function send_mail(array $d): bool
{
    $plan = PLANS[$d['plan']];
    $subject = '[' . SITE_NAME . '] Nouveau message - ' . $plan['ascii'];

    $line = str_repeat('-', 44);
    $body = implode("\r\n", [
        'Nouveau message reçu depuis le site ' . SITE_NAME,
        $line,
        'Nom      : ' . $d['name'],
        'E-mail   : ' . $d['email'],
        'Formule  : ' . $plan['label'],
        'Option   : ' . ($d['hosting'] ? '+30 € Aide à la configuration hébergement (demandée)' : 'aucune'),
        $line,
        'Message :',
        '',
        str_replace("\n", "\r\n", $d['message']),
        '',
        $line,
        'Reçu le ' . date('d/m/Y à H:i') . ' (heure de Paris).',
        'Pour répondre, utilise simplement « Répondre » : la réponse part vers le visiteur.',
    ]);

    $headers = implode("\r\n", [
        'From: ' . mime_header(SITE_NAME) . ' <' . MAIL_FROM . '>',
        'Reply-To: ' . $d['email'],
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        'X-Mailer: monsite-contact',
    ]);

    $params = ENVELOPE_FROM && filter_var(MAIL_FROM, FILTER_VALIDATE_EMAIL) ? '-f' . MAIL_FROM : '';
    return @mail(CONTACT_TO, mime_header($subject), quoted_printable_encode($body), $headers, $params);
}


/* ============================== Traitement principal ============================== */

// Garde-fou : tant que les adresses d'exemple sont là, rien n'est envoyé
if (preg_match('/@example\.(?:com|org|net)$/i', CONTACT_TO) || preg_match('/@example\.(?:com|org|net)$/i', MAIL_FROM)) {
    error_log('[monsite-contact] configure CONTACT_TO et MAIL_FROM dans formulaire.php');
    fail(500, 'config', 'Le formulaire n’est pas encore configuré.');
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'POST') {
    header('Allow: GET, POST');
    fail(405, 'method', 'Méthode non autorisée.');
}

garbage_collect();

/* ---- GET ?action=token : jeton signé ---- */
if ($method === 'GET') {
    if (($_GET['action'] ?? '') !== 'token') {
        fail(400, 'invalid', 'Requête invalide.');
    }
    if (!rate_ok('t:' . client_key(), LIMIT_TOKENS)) {
        header('Retry-After: 3600');
        fail(429, 'rate', 'Trop de demandes. Merci de réessayer plus tard.');
    }
    respond(200, ['ok' => true, 'token' => issue_token()]);
}

/* ---- POST : envoi du message ---- */
check_origin();
$who = client_key();

if (!rate_ok('a:' . $who, LIMIT_ATTEMPTS)) {
    header('Retry-After: 600');
    fail(429, 'rate', 'Trop de tentatives. Merci de réessayer dans quelques minutes.');
}

$input = read_json();

// Honeypot : un humain ne voit pas ce champ. Faux succès : le robot ne sait pas qu'il est repéré.
if (isset($input['website']) && $input['website'] !== '') {
    respond(200, ['ok' => true, 'message' => 'Message envoyé.']);
}

// Jeton : signature valide, pas trop récent (robot), pas trop ancien
$token = verify_token((string) ($input['token'] ?? ''));
if ($token === null || time() - $token['i'] > TOKEN_TTL || $token['i'] > time() + 5) {
    fail(400, 'token', 'Session expirée. Merci de réessayer.');
}
if (time() - $token['i'] < MIN_FILL_SECONDS) {
    fail(400, 'too_fast', 'Envoi trop rapide. Merci de réessayer dans un instant.');
}

[$clean, $errors] = validate($input);
if ($errors) {
    fail(422, 'validation', 'Merci de vérifier les champs indiqués.', ['errors' => $errors]);
}

if (!rate_ok('s:' . $who, LIMIT_SENT_IP, false) || !rate_ok('s:all', LIMIT_SENT_ALL, false)) {
    header('Retry-After: 3600');
    fail(429, 'rate', 'Trop de messages envoyés pour le moment. Merci de réessayer plus tard.');
}

// Un jeton ne sert qu'une fois (anti-rejeu)
if (!claim_nonce($token['n'])) {
    fail(400, 'token', 'Session expirée. Merci de réessayer.');
}

if (!send_mail($clean)) {
    release_nonce($token['n']);       // l'utilisateur pourra réessayer avec le même jeton
    error_log('[monsite-contact] mail() a échoué (configuration d\'envoi de l\'hébergement ?)');
    fail(500, 'mail', 'Le message n’a pas pu être envoyé. Merci de réessayer plus tard.');
}

rate_ok('s:' . $who, LIMIT_SENT_IP);
rate_ok('s:all', LIMIT_SENT_ALL);
respond(200, ['ok' => true, 'message' => 'Message envoyé. Merci !']);
