
// ==========================================
// POOL SHOT CLOCK — APPLICATION LOGIC
// Version 0.2
// ==========================================

"use strict";

const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const STORAGE_KEY = "pool-shot-clock-v1";
const CIRCUMFERENCE = 2 * Math.PI * 85;

// ==========================================
// DEFAULT SETTINGS
// ==========================================

const defaults = {
    names: ["PLAYER 1", "PLAYER 2"],
    countries: ["", ""],
    fargoRatings: ["", ""],

    scoringMode: "sets",
    raceLength: 4,
    setCount: 3,

    clockEnabled: true,
    shotDuration: 30,
    firstShotDuration: 60,
    extensionDuration: 30,
    extensionsPerRack: 1,

    orangeThreshold: 10,
    redThreshold: 5,

    soundProfile: "classic",
    soundVolume: 75,

    warningEnabled: true,
    warningSeconds: 10,
    countdownEnabled: true,
    countdownSeconds: 5,
    expirationEnabled: true,

    shootoutAttempts: 4,
    suddenDeath: true
};

let settings = clone(defaults);

function createMatch() {
    const count = settings.scoringMode === "race"
        ? 1 : settings.setCount;

    return {
        scores: Array.from(
            { length: count },
            () => [0, 0]
        ),

        setWinners: Array(count).fill(null),
        currentSet: 0,
        activePlayer: 0,
        winner: null,

        extensions: [
            settings.extensionsPerRack,
            settings.extensionsPerRack
        ],

        remaining: settings.firstShotDuration,
        clockTotal: settings.firstShotDuration,
        clockState: "ready",
        clockMode: "after-break",

        shootout: null
    };
}

let match = createMatch();
let history = [];

let deadline = null;
let lastDisplayedSecond = null;
let audioContext = null;
let wakeLock = null;

// ==========================================
// LOCAL STORAGE
// ==========================================

function saveState() {
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ settings, match, history })
        );
    } catch (error) {
        console.warn("Unable to save match:", error);
    }
}

function loadState() {
    try {
        const saved = JSON.parse(
            localStorage.getItem(STORAGE_KEY)
        );

        if (!saved) return;

        settings = {
            ...defaults,
            ...saved.settings
        };

        match = saved.match || createMatch();
        history = saved.history || [];

        if (!match.clockMode) {
            match.clockMode =
                match.clockTotal === settings.firstShotDuration
                    ? "after-break"
                    : "normal";
        }

        // Never resume a running clock automatically.
        if (match.clockState === "running") {
            match.clockState = "paused";
        }

    } catch (error) {
        console.warn("Unable to restore match:", error);
        settings = clone(defaults);
        match = createMatch();
    }
}

// ==========================================
// UNDO HISTORY
// ==========================================

function rememberState() {
    const snapshot = clone(match);

    if (snapshot.clockState === "running") {
        snapshot.remaining = getRemaining();
        snapshot.clockState = "paused";
    }

    history.push({
        settings: clone(settings),
        match: snapshot
    });

    if (history.length > 100) {
        history.shift();
    }
}

function undo() {
    if (!history.length) return;

    const previous = history.pop();

    deadline = null;
    settings = previous.settings;
    match = previous.match;

    if (!match.clockMode) {
        match.clockMode =
            match.clockTotal === settings.firstShotDuration
                ? "after-break"
                : "normal";
    }

    lastDisplayedSecond = null;

    render();
    saveState();
}

// ==========================================
// SHOT CLOCK
// ==========================================

function getRemaining() {
    if (
        match.clockState === "running" &&
        deadline !== null
    ) {
        return Math.max(
            0,
            (deadline - performance.now()) / 1000
        );
    }

    return match.remaining;
}

function startClock() {
    if (!settings.clockEnabled) return;
    if (match.winner !== null) return;
    if (match.shootout) return;
    if (match.remaining <= 0) return;

    unlockAudio();

    deadline =
        performance.now() +
        match.remaining * 1000;

    match.clockState = "running";
    lastDisplayedSecond = Math.ceil(match.remaining);

    requestWakeLock();

    render();
    saveState();
}

function pauseClock() {
    if (match.clockState !== "running") return;

    match.remaining = getRemaining();
    match.clockState = "paused";
    deadline = null;

    render();
    saveState();
}

function toggleClock() {
    if (match.clockState === "running") {
        pauseClock();
    } else {
        startClock();
    }
}

function prepareClock(duration, mode = "normal") {
    deadline = null;

    match.clockMode = mode;

    match.remaining = duration;
    match.clockTotal = duration;
    match.clockState = "ready";

    lastDisplayedSecond = null;
}

function resetClock() {
    if (!settings.clockEnabled) return;
    if (match.winner !== null) return;
    if (match.shootout) return;

    rememberState();

    prepareClock(
        settings.shotDuration,
        "normal"
    );

    startClock();
}

function selectClockMode(mode) {
    if (!settings.clockEnabled) return;
    if (match.winner !== null) return;
    if (match.shootout) return;

    rememberState();

    const duration =
        mode === "after-break"
            ? settings.firstShotDuration
            : settings.shotDuration;

    prepareClock(duration, mode);

    startClock();
}

function expireClock() {
    match.remaining = 0;
    match.clockState = "expired";

    deadline = null;

    if (settings.expirationEnabled ?? true) {
        playSound("expiration");
    }

    render();
    saveState();
}

function tick() {
    if (match.clockState !== "running") return;

    const remaining = getRemaining();
    match.remaining = remaining;

    const seconds = Math.ceil(remaining);

    if (remaining <= 0) {
        expireClock();
        return;
    }

    if (seconds !== lastDisplayedSecond) {
        const previous = lastDisplayedSecond;

        const decreasing =
            previous !== null &&
            seconds < previous;

        if (decreasing) {
            const warning =
                settings.warningSeconds ?? 10;

            const countdown =
                settings.countdownSeconds ?? 5;

            const warningDue =
                (settings.warningEnabled ?? true) &&
                previous > warning &&
                seconds === warning;

            const countdownDue =
                (settings.countdownEnabled ?? true) &&
                seconds <= countdown &&
                seconds > 0;

            // Warning takes priority if thresholds overlap.
            if (warningDue) {
                playSound("warning");
            } else if (countdownDue) {
                playSound("countdown");
            }
        }

        lastDisplayedSecond = seconds;
        saveState();
    }

    renderClock();
}

setInterval(tick, 50);

// ==========================================
// EXTENSIONS
// ==========================================

function replenishExtensions() {
    match.extensions = [
        settings.extensionsPerRack,
        settings.extensionsPerRack
    ];
}

function useExtension(player) {
    if (!settings.clockEnabled) return;
    if (match.extensions[player] <= 0) return;
    if (match.winner !== null) return;
    if (match.shootout) return;
    if (match.clockState === "expired") return;

    rememberState();

    const remaining = getRemaining();

    match.activePlayer = player;
    match.extensions[player]--;

    match.remaining =
        remaining + settings.extensionDuration;

    match.clockTotal = Math.max(
        match.clockTotal,
        match.remaining
    );

    if (match.clockState === "running") {
        deadline =
            performance.now() +
            match.remaining * 1000;
    }

    lastDisplayedSecond = Math.ceil(match.remaining);

    render();
    saveState();
}

// ==========================================
// MATCH SCORING
// ==========================================

function setsNeeded() {
    return settings.scoringMode === "race"
        ? 1
        : Math.floor(settings.setCount / 2) + 1;
}

function setsWon(player) {
    return match.setWinners.filter(
        winner => winner === player
    ).length;
}

function awardRack(player) {
    if (match.winner !== null) return;
    if (match.shootout) return;

    rememberState();

    const index = match.currentSet;

    match.scores[index][player]++;

    if (
        match.scores[index][player] >=
        settings.raceLength
    ) {
        match.setWinners[index] = player;

        if (setsWon(player) >= setsNeeded()) {
            match.winner = player;
        } else {
            match.currentSet++;
        }
    }

    replenishExtensions();

    prepareClock(
        settings.firstShotDuration,
        "after-break"
    );

    render();
    saveState();
}

function subtractRack(player) {
    if (match.winner !== null) return;
    if (match.shootout) return;

    const index = match.currentSet;

    if (match.scores[index][player] <= 0) return;

    rememberState();

    match.scores[index][player]--;

    render();
    saveState();
}

function selectPlayer(player) {
    if (match.winner !== null) return;
    if (match.shootout) return;
    if (match.activePlayer === player) return;

    rememberState();

    match.activePlayer = player;

    render();
    saveState();
}

function switchPlayer() {
    if (!settings.clockEnabled) return;
    if (match.winner !== null) return;
    if (match.shootout) return;

    rememberState();

    match.activePlayer =
        1 - match.activePlayer;

    prepareClock(
        settings.shotDuration,
        "normal"
    );

    startClock();
}

// ==========================================
// SHOOTOUT
// ==========================================

function enterShootout() {
    if (match.shootout) return;

    rememberState();
    pauseClock();

    match.shootout = {
        attempts: [[], []],
        activePlayer: 0,
        winner: null,
        finished: false
    };

    render();
    saveState();
}

function shootoutScore(player) {
    return match.shootout.attempts[player]
        .filter(Boolean).length;
}

function evaluateShootout() {
    const shootout = match.shootout;
    const count = settings.shootoutAttempts;

    const attempts1 = shootout.attempts[0].length;
    const attempts2 = shootout.attempts[1].length;

    const score1 = shootoutScore(0);
    const score2 = shootoutScore(1);

    const remaining1 = Math.max(0, count - attempts1);
    const remaining2 = Math.max(0, count - attempts2);

    // End early if the trailing player
    // cannot mathematically catch up.
    if (
        attempts1 <= count &&
        attempts2 <= count
    ) {
        if (score1 > score2 + remaining2) {
            shootout.winner = 0;
            shootout.finished = true;
            return;
        }

        if (score2 > score1 + remaining1) {
            shootout.winner = 1;
            shootout.finished = true;
            return;
        }
    }

    // Both players must have equal attempts
    // before deciding sudden death.
    if (
        attempts1 >= count &&
        attempts2 >= count &&
        attempts1 === attempts2
    ) {
        if (score1 !== score2) {
            shootout.winner =
                score1 > score2 ? 0 : 1;

            shootout.finished = true;

        } else if (!settings.suddenDeath) {
            shootout.finished = true;
        }
    }
}

function recordAttempt(made) {
    const shootout = match.shootout;

    if (!shootout || shootout.finished) return;

    rememberState();

    const player = shootout.activePlayer;

    shootout.attempts[player].push(made);

    evaluateShootout();

    if (!shootout.finished) {
        shootout.activePlayer = 1 - player;
    }

    render();
    saveState();
}

function exitShootout() {
    if (!match.shootout) return;

    rememberState();

    match.shootout = null;

    render();
    saveState();
}

// ==========================================
// AUDIO ENGINE
// ==========================================

function unlockAudio() {
    try {

        if ("audioSession" in navigator) {
            try {
                navigator.audioSession.type = "playback";
            } catch (error) {
                console.warn("Audio session:", error);
            }
        }

        const AudioClass =
            window.AudioContext ||
            window.webkitAudioContext;

        if (!AudioClass) return;

        if (!audioContext) {
            audioContext = new AudioClass();
        }

        if (audioContext.state === "suspended") {
            audioContext.resume().catch(() => {});
        }

    } catch (error) {
        console.warn("Audio unavailable:", error);
    }
}

function tone(
    frequency,
    duration,
    waveform,
    delay = 0,
    level = 1,
    volumePercent = settings.soundVolume
) {
    if (!audioContext) return;
    if (volumePercent <= 0) return;

    const oscillator =
        audioContext.createOscillator();

    const gain = audioContext.createGain();

    const start =
        audioContext.currentTime + delay;

    const volume = Math.max(
        0.0001,
        (volumePercent / 100) * 0.25 * level
    );

    oscillator.type = waveform;
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(0.0001, start);

    gain.gain.exponentialRampToValueAtTime(
        volume,
        start + 0.006
    );

    gain.gain.exponentialRampToValueAtTime(
        0.0001,
        start + duration
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);

    oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
    };
}


const TOURNAMENT_AUDIO_PROFILES = {

    matchroom: {
        fundamental: 440,
        attack: 2,
        duration: 300,
        spacing: 170,
        sustain: 80,
        fade: 60,

        db: [
            0, -2.02, -2.19, -18.55, -30.29,
            -18.92, -27.32, -31.62, -21.81, -24.70
        ],

        decay: [
            158, 171, 112, 292, 250,
            217, 200, 266, 172, 188
        ]
    },

    predator: {
        fundamental: 523.25,
        attack: 0.5,
        duration: 280,
        spacing: 170,
        sustain: 0,
        fade: 5,

        db: [
            0, -52.6, -1.7, -17.18, -11.39,
            -60, -60, -60, -60, -60
        ],

        decay: [
            242, 100, 288, 120, 120,
            100, 100, 100, 100, 100
        ]
    }
};

const tournamentAudioCache = new Map();

function createTournamentBuffer(profile) {

    const p = TOURNAMENT_AUDIO_PROFILES[profile];
    const ctx = audioContext;

    const key = profile + ":" + ctx.sampleRate;

    if (tournamentAudioCache.has(key)) {
        return tournamentAudioCache.get(key);
    }

    const rate = ctx.sampleRate;
    const duration = p.duration / 1000;

    const length = Math.ceil(duration * rate);

    const buffer = ctx.createBuffer(
        1, length, rate
    );

    const samples = buffer.getChannelData(0);

    const attack = Math.min(
        p.attack / 1000, duration * 0.2
    );

    const fade = Math.min(
        p.fade / 1000, duration * 0.8
    );

    const amplitudes = p.db.map(
        db => db <= -60 ? 0 : Math.pow(10, db / 20)
    );

    const normalization = amplitudes.reduce(
        (sum, value) => sum + value, 0
    );

    for (let i = 0; i < length; i++) {

        const t = i / rate;

        const attackGain = Math.min(1, t / attack);

        const releaseGain = Math.max(
            0,
            Math.min(1, (duration - t) / fade)
        );

        let sample = 0;

        for (let h = 0; h < amplitudes.length; h++) {

            if (amplitudes[h] === 0) continue;

            const frequency = p.fundamental * (h + 1);
            const tau = p.decay[h] / 1000;

            const hold = h === 2
                ? p.sustain / 1000
                : 0;

            const decayTime = Math.max(
                0, t - attack - hold
            );

            const envelope = Math.exp(
                -decayTime / tau
            );

            sample += amplitudes[h]
                * envelope
                * Math.sin(2 * Math.PI * frequency * t);
        }

        samples[i] = sample
            * attackGain
            * releaseGain
            / normalization;
    }

    tournamentAudioCache.set(key, buffer);

    return buffer;
}

function playTournamentSequence(
    profile, offsets, delay, volume
) {

    unlockAudio();

    if (!audioContext) return;

    const ctx = audioContext;

    const buffer = createTournamentBuffer(profile);

    const gain = ctx.createGain();

    gain.gain.value =
        Math.max(0, Math.min(100, volume)) / 100 * 0.65;

    const compressor = ctx.createDynamicsCompressor();

    compressor.threshold.value = -3;
    compressor.knee.value = 0;
    compressor.ratio.value = 20;
    compressor.attack.value = 0.001;
    compressor.release.value = 0.05;

    gain.connect(compressor);
    compressor.connect(ctx.destination);

    const start = ctx.currentTime + 0.03 + delay;

    let remaining = offsets.length;

    for (const offset of offsets) {

        const source = ctx.createBufferSource();

        source.buffer = buffer;
        source.connect(gain);

        source.onended = () => {

            source.disconnect();
            remaining--;

            if (remaining === 0) {
                gain.disconnect();
                compressor.disconnect();
            }
        };

        source.start(start + offset);
    }
}

function playSound(
    event = "countdown",
    delay = 0,
    profile = settings.soundProfile,
    volume = settings.soundVolume
) {

    if (event === true) event = "expiration";
    if (event === false) event = "countdown";

    if (profile === "silent" || volume <= 0) return;

    if (profile === "classic") {

        if (event === "warning") {

            tone(900, 0.15, "sine", delay, 1, volume);
            tone(1200, 0.15, "sine", delay + 0.18, 1, volume);

        } else if (event === "expiration") {

            tone(500, 0.7, "sine", delay, 1, volume);

        } else {

            tone(1200, 0.15, "sine", delay, 1, volume);
        }

        return;
    }

    if (!TOURNAMENT_AUDIO_PROFILES[profile]) return;

    if (event === "expiration" || event === "expired") {

        playTournamentSequence(
            profile,
            [0, 0.17, 0.34, 0.51, 0.68],
            delay,
            volume
        );

    } else if (event === "warning") {

        playTournamentSequence(
            profile,
            [0],
            delay,
            volume
        );

    } else {

        playTournamentSequence(
            profile,
            [0],
            delay,
            volume
        );
    }
}



// ==========================================
// SCREEN WAKE LOCK
// ==========================================

let wakeLockPending = false;

async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    if (document.visibilityState !== "visible") return;
    if (wakeLock && !wakeLock.released) return;
    if (wakeLockPending) return;

    wakeLockPending = true;

    try {
        const lock = await navigator.wakeLock.request("screen");

        wakeLock = lock;

        lock.addEventListener("release", () => {
            if (wakeLock === lock) {
                wakeLock = null;
            }

            console.log("Screen wake lock released.");
        });

        console.log("Screen wake lock active.");

    } catch (error) {
        console.warn("Wake lock unavailable:", error);

    } finally {
        wakeLockPending = false;
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        requestWakeLock();

        if (match.clockState === "running") {
            tick();
        }
    }
});

document.addEventListener("pointerdown", requestWakeLock, {
    passive: true
});

window.addEventListener("pageshow", requestWakeLock);

requestWakeLock();


// ==========================================
// COUNTRY OPTIONS
// ==========================================

const countries = {
    "ain": "AIN (Individual Neutral Athletes)",
    "tpe": "Chinese Taipei",
    "un": "United Nations",
    "ar": "Argentina",
    "au": "Australia",
    "at": "Austria",
    "be": "Belgium",
    "br": "Brazil",
    "ca": "Canada",
    "cn": "China",
    "cz": "Czechia",
    "dk": "Denmark",
    "ee": "Estonia",
    "fi": "Finland",
    "fr": "France",
    "de": "Germany",
    "gb-eng": "England",
    "gb-sct": "Scotland",
    "gb-wls": "Wales",
    "gb": "United Kingdom",
    "gr": "Greece",
    "hk": "Hong Kong",
    "hu": "Hungary",
    "id": "Indonesia",
    "ie": "Ireland",
    "it": "Italy",
    "jp": "Japan",
    "kr": "South Korea",
    "my": "Malaysia",
    "mx": "Mexico",
    "nl": "Netherlands",
    "nz": "New Zealand",
    "no": "Norway",
    "ph": "Philippines",
    "pl": "Poland",
    "pt": "Portugal",
    "ro": "Romania",
    "sa": "Saudi Arabia",
    "sg": "Singapore",
    "sk": "Slovakia",
    "es": "Spain",
    "se": "Sweden",
    "ch": "Switzerland",
    "tw": "Taiwan",
    "th": "Thailand",
    "tr": "Türkiye",
    "ua": "Ukraine",
    "ae": "United Arab Emirates",
    "us": "United States",
    "vn": "Vietnam"
};

function populateCountries() {
    const entries = Object.entries(countries)
        .sort((a, b) => a[1].localeCompare(b[1]));

    for (const id of ["country-1", "country-2"]) {
        const select = $(id);

        for (const [code, name] of entries) {
            const option =
                document.createElement("option");

            option.value = code;
            option.textContent = name;

            select.appendChild(option);
        }
    }
}

function renderFlag(player) {
    const flag = $(`flag-${player + 1}`);
    const code = settings.countries[player] || "white";

    const source = `flags/${code}.svg`;

    flag.alt = code === "white" ? "No country" : countries[code] || code;

    flag.onload = () => {
        flag.hidden = false;
    };

    flag.onerror = () => {
        flag.hidden = true;
    };

    if (flag.getAttribute("src") !== source) {
        flag.hidden = true;
        flag.src = source;
    }
}

// ==========================================
// RENDER SHOT CLOCK
// ==========================================

function renderClock() {
    $("pause-btn").classList.toggle(
        "running",
        match.clockState === "running"
    );

    $("switch-btn").disabled =
        !settings.clockEnabled ||
        match.winner !== null ||
        !!match.shootout;

    const remaining = getRemaining();
    const seconds = Math.ceil(remaining);

    const fraction = Math.max(
        0,
        Math.min(1, remaining / match.clockTotal)
    );

    $("clock-value").textContent = seconds;

    const afterBreak =
        match.clockMode === "after-break";

    $("clock-mode-label").textContent =
        afterBreak ? "AFTER BREAK" : "NORMAL SHOT";

    $("clock-mode-label").style.color =
        afterBreak ? "#8eb8db" : "#a1a7af";

    $("after-break-label").textContent =
        `${settings.firstShotDuration}s`;

    $("normal-clock-label").textContent =
        `${settings.shotDuration}s`;

    $("after-break-btn").classList.toggle(
        "selected",
        afterBreak
    );

    $("normal-clock-btn").classList.toggle(
        "selected",
        !afterBreak
    );

    $("after-break-btn").disabled =
        match.winner !== null || !!match.shootout;

    $("normal-clock-btn").disabled =
        match.winner !== null || !!match.shootout;

    const ring = $("ring-progress");

    ring.style.strokeDasharray = CIRCUMFERENCE;

    ring.style.strokeDashoffset =
        CIRCUMFERENCE * (1 - fraction);

    let color = "#28b84b";

    if (seconds <= settings.redThreshold) {
        color = "#ef4444";
    } else if (seconds <= settings.orangeThreshold) {
        color = "#f59e0b";
    }

    ring.style.stroke = color;

    $("clock-value").style.color =
        match.clockState === "expired"
            ? "#ef4444"
            : "#ffffff";

    const labels = {
        ready: "READY",
        running: "SHOT CLOCK",
        paused: "PAUSED",
        expired: "TIME"
    };

    $("clock-status").textContent =
        labels[match.clockState];

    const pause = $("pause-btn");

    pause.textContent =
        match.clockState === "running" ? "PAUSE" :
        match.clockState === "paused" ? "RESUME" :
        match.clockState === "expired" ? "TIME" :
        "START";

    pause.classList.toggle(
        "running",
        match.clockState === "running"
    );

    pause.disabled =
        match.clockState === "expired" ||
        match.winner !== null ||
        !!match.shootout;
}

// ==========================================
// RENDER SCOREBOARD
// ==========================================

function renderScoreboard() {
    const format =
        `Race to ${settings.raceLength}`;

    $("match-format").textContent =
        settings.scoringMode === "sets"
            ? `${format} — Best of ${settings.setCount} Sets`
            : format;

    if (match.winner !== null) {
        $("match-format").textContent =
            `${settings.names[match.winner]} WINS`;
    }

    for (let player = 0; player < 2; player++) {
        const n = player + 1;

        $(`name-${n}`).textContent =
            settings.names[player];

        $(`control-name-${n}`).textContent =
            settings.names[player];

        $(`player-${n}-row`).classList.toggle(
            "active",
            match.activePlayer === player
        );

        const isActive =
            match.activePlayer === player;

        $(`active-${n}`).hidden = !isActive;

        $(`player-panel-${n}`).classList.toggle(
            "active",
            isActive
        );

        renderFlag(player);

        const ratings =
            settings.fargoRatings ?? ["", ""];

        const rating =
            ratings[player] ?? "";

        const showRatings = ratings.some(
            value => value !== "" && value != null
        );

        $(`fargo-${n}`).textContent = rating;
        $(`fargo-${n}`).hidden = !showRatings;

        const scores = $(`scores-${n}`);
        scores.replaceChildren();

        match.scores.forEach((score, index) => {
            const cell =
                document.createElement("span");

            cell.className = "set-score";
            cell.textContent = score[player];

            if (index === match.currentSet) {
                cell.classList.add("current");
            }

            if (match.setWinners[index] !== null) {
                cell.classList.add("completed");
            }

            if (match.setWinners[index] === player) {
                cell.classList.add("winner");
            }

            scores.appendChild(cell);
        });

        const extensionsLeft =
            match.extensions[player];

        const exhausted =
            extensionsLeft <= 0;

        $(`extension-count-${n}`).textContent =
            `${extensionsLeft} / ${settings.extensionsPerRack}`;

        $(`extensions-left-${n}`).textContent =
            exhausted
                ? "No extensions left"
                : `+${settings.extensionDuration} seconds`;

        $(`scoreboard-ext-${n}`).textContent =
            exhausted
                ? "NO EXT LEFT"
                : `${extensionsLeft} EXT LEFT`;

        $(`scoreboard-ext-${n}`).classList.toggle(
            "exhausted",
            exhausted
        );

        $(`extension-${n}`).classList.toggle(
            "exhausted",
            exhausted
        );

        $(`extension-${n}`).disabled =
            match.extensions[player] <= 0 ||
            match.winner !== null ||
            match.clockState === "expired" ||
            !!match.shootout;

        $(`extension-${n}`).hidden =
            !settings.clockEnabled;

        $(`rack-${n}`).disabled =
            match.winner !== null ||
            !!match.shootout;

        $(`subtract-${n}`).disabled =
            match.scores[match.currentSet][player] <= 0 ||
            match.winner !== null ||
            !!match.shootout;
    }
}

// ==========================================
// RENDER SHOOTOUT
// ==========================================

function renderShootout() {
    const shootout = match.shootout;

    $("shootout-panel").hidden = !shootout;

    if (!shootout) return;

    const round =
        Math.min(
            shootout.attempts[0].length,
            shootout.attempts[1].length
        ) + 1;

    if (shootout.finished) {
        $("shootout-round").textContent =
            shootout.winner === null
                ? "SHOOTOUT TIED"
                : `${settings.names[shootout.winner]} WINS`;

    } else {
        const phase =
            round > settings.shootoutAttempts
                ? "SUDDEN DEATH"
                : `ROUND ${round} OF ${settings.shootoutAttempts}`;

        $("shootout-round").textContent =
            `${phase} — ${settings.names[shootout.activePlayer]} TO SHOOT`;
    }

    for (let player = 0; player < 2; player++) {
        const n = player + 1;

        $(`shootout-name-${n}`).textContent =
            settings.names[player];

        $(`shootout-score-${n}`).textContent =
            shootoutScore(player);

        const row = $(`shootout-name-${n}`).closest(".shootout-row");

        row.classList.toggle(
            "active",
            !shootout.finished && shootout.activePlayer === player
        );

        const flag = $(`shootout-flag-${n}`);
        const source = `flags/${settings.countries[player] || "white"}.svg`;

        if (flag.getAttribute("src") !== source) {
            flag.src = source;
        }

        const container = $(`attempts-${n}`);
        container.replaceChildren();

        const attempts = shootout.attempts[player];

        const count = Math.max(
            settings.shootoutAttempts,
            shootout.attempts[0].length,
            shootout.attempts[1].length,
            shootout.finished ? 0 : round
        );

        for (let i = 0; i < count; i++) {
            const dot = document.createElement("span");

            dot.className = "attempt";

            if (i < attempts.length) {
                dot.classList.add(
                    attempts[i] ? "made" : "missed"
                );

                dot.textContent =
                    attempts[i] ? "✓" : "×";
            }

            container.appendChild(dot);
        }

        container.scrollLeft = container.scrollWidth;
    }

    $("shootout-undo-btn").disabled = !history.length;
    $("made-btn").disabled = shootout.finished;
    $("missed-btn").disabled = shootout.finished;
}

// ==========================================
// MAIN RENDER
// ==========================================

function render() {
    $("clock-container").hidden =
        !settings.clockEnabled;

    $("clock-controls").hidden =
        !settings.clockEnabled || !!match.shootout;

    $("clock-mode-controls").hidden =
        !settings.clockEnabled || !!match.shootout;

    $("app").classList.toggle(
        "clock-hidden",
        !settings.clockEnabled
    );

    $("hide-clock-btn").textContent =
        settings.clockEnabled
            ? "Hide Clock"
            : "Show Clock";

    $("undo-btn").disabled = !history.length;

    $("reset-btn").disabled =
        match.winner !== null || !!match.shootout;

    $("shootout-btn").disabled = !!match.shootout;

    renderScoreboard();
    renderClock();
    renderShootout();
}

// ==========================================
// SETTINGS
// ==========================================

function openSettings() {
    pauseClock();

    $("input-name-1").value = settings.names[0];
    $("input-name-2").value = settings.names[1];

    $("country-1").value = settings.countries[0];
    $("country-2").value = settings.countries[1];

    $("scoring-mode").value = settings.scoringMode;
    $("race-length").value = settings.raceLength;
    $("set-count").value = settings.setCount;

    $("clock-enabled").checked = settings.clockEnabled;
    $("shot-duration").value = settings.shotDuration;

    $("first-shot-duration").value =
        settings.firstShotDuration;

    $("extension-duration").value =
        settings.extensionDuration;

    $("extensions-per-rack").value =
        settings.extensionsPerRack;

    $("orange-threshold").value =
        settings.orangeThreshold;

    $("red-threshold").value =
        settings.redThreshold;

    $("input-fargo-1").value =
        settings.fargoRatings?.[0] ?? "";

    $("input-fargo-2").value =
        settings.fargoRatings?.[1] ?? "";

    $("warning-enabled").checked =
        settings.warningEnabled ?? true;

    $("warning-seconds").value =
        settings.warningSeconds ?? 10;

    $("countdown-enabled").checked =
        settings.countdownEnabled ?? true;

    $("countdown-seconds").value =
        settings.countdownSeconds ?? 5;

    $("expiration-enabled").checked =
        settings.expirationEnabled ?? true;

    $("sound-profile").value = settings.soundProfile;
    $("sound-volume").value = settings.soundVolume;

    $("shootout-attempts").value =
        settings.shootoutAttempts;

    $("sudden-death").checked = settings.suddenDeath;

    $("settings-dialog").showModal();
}

function readSettings() {
    const number = id => Number($(id).value);

    return {
        names: [
            $("input-name-1").value.trim() || "PLAYER 1",
            $("input-name-2").value.trim() || "PLAYER 2"
        ],

        countries: [
            $("country-1").value,
            $("country-2").value
        ],

        scoringMode: $("scoring-mode").value,
        raceLength: number("race-length"),
        setCount: number("set-count"),

        clockEnabled: $("clock-enabled").checked,
        shotDuration: number("shot-duration"),

        firstShotDuration:
            number("first-shot-duration"),

        extensionDuration:
            number("extension-duration"),

        extensionsPerRack:
            number("extensions-per-rack"),

        orangeThreshold:
            number("orange-threshold"),

        redThreshold:
            number("red-threshold"),

        fargoRatings: [
            $("input-fargo-1").value,
            $("input-fargo-2").value
        ],

        warningEnabled:
            $("warning-enabled").checked,

        warningSeconds:
            number("warning-seconds"),

        countdownEnabled:
            $("countdown-enabled").checked,

        countdownSeconds:
            number("countdown-seconds"),

        expirationEnabled:
            $("expiration-enabled").checked,

        soundProfile: $("sound-profile").value,
        soundVolume: number("sound-volume"),

        shootoutAttempts:
            number("shootout-attempts"),

        suddenDeath: $("sudden-death").checked
    };
}

function validateSettings(next) {
    if (!$("settings-form").reportValidity()) {
        return false;
    }

    if (next.redThreshold > next.orangeThreshold) {
        alert(
            "The red threshold must not exceed " +
            "the orange threshold."
        );

        return false;
    }

    if (
        next.scoringMode === "sets" &&
        next.setCount % 2 === 0
    ) {
        alert("Best-of sets must be an odd number.");
        return false;
    }

    return true;
}

function saveSettings(event) {
    event.preventDefault();

    const next = readSettings();

    if (!validateSettings(next)) return;

    const formatChanged =
        next.scoringMode !== settings.scoringMode ||
        next.raceLength !== settings.raceLength ||
        next.setCount !== settings.setCount;

    if (
        formatChanged &&
        !confirm(
            "Changing the match format will reset " +
            "the current match. Continue?"
        )
    ) {
        return;
    }

    rememberState();

    const previous = settings;

    settings = next;

    if (formatChanged) {
        match = createMatch();

    } else {
        // Preserve extensions already consumed.
        match.extensions = match.extensions.map(
            remaining => {
                const used =
                    previous.extensionsPerRack - remaining;

                return Math.max(
                    0,
                    settings.extensionsPerRack - used
                );
            }
        );

        const afterBreak =
            match.clockMode === "after-break";

        if (
            !afterBreak &&
            previous.shotDuration !==
            settings.shotDuration
        ) {
            prepareClock(
                settings.shotDuration,
                "normal"
            );

        } else if (
            afterBreak &&
            previous.firstShotDuration !==
            settings.firstShotDuration
        ) {
            prepareClock(
                settings.firstShotDuration,
                "after-break"
            );
        }
    }

    $("settings-dialog").close();

    render();
    saveState();
}

function newMatch() {
    const next = readSettings();

    if (!validateSettings(next)) return;

    if (!confirm("Start a new match?")) return;

    rememberState();

    settings = next;
    deadline = null;
    match = createMatch();

    $("settings-dialog").close();

    render();
    saveState();
}

function toggleClockVisibility() {
    rememberState();

    if (settings.clockEnabled) {
        pauseClock();
    }

    settings.clockEnabled = !settings.clockEnabled;

    render();
    saveState();
}

function testSound() {
    const profile = $("sound-profile").value;
    const volume = Number($("sound-volume").value);

    if (profile === "silent" || volume <= 0) {
        return;
    }

    unlockAudio();

    let delay = 0;

    if ($("warning-enabled").checked) {
        playSound("warning", delay, profile, volume);
        delay += 0.85;
    }

    if ($("countdown-enabled").checked) {
        for (let i = 0; i < 3; i++) {
            playSound(
                "countdown",
                delay + i,
                profile,
                volume
            );
        }

        delay += 3;
    }

    if ($("expiration-enabled").checked) {
        playSound(
            "expiration",
            delay,
            profile,
            volume
        );
    }
}

// ==========================================
// EVENT LISTENERS
// ==========================================

$("pause-btn").addEventListener("click", toggleClock);
$("reset-btn").addEventListener("click", resetClock);
$("undo-btn").addEventListener("click", undo);

$("after-break-btn").addEventListener(
    "click",
    () => selectClockMode("after-break")
);

$("normal-clock-btn").addEventListener(
    "click",
    () => selectClockMode("normal")
);

$("hide-clock-btn").addEventListener(
    "click",
    toggleClockVisibility
);

$("settings-btn").addEventListener(
    "click",
    openSettings
);

$("settings-form").addEventListener(
    "submit",
    saveSettings
);

$("cancel-settings").addEventListener(
    "click",
    () => $("settings-dialog").close()
);

$("new-match-btn").addEventListener(
    "click",
    newMatch
);

$("test-sound-btn").addEventListener(
    "click",
    testSound
);

for (let player = 0; player < 2; player++) {
    const n = player + 1;

    $(`rack-${n}`).addEventListener(
        "click",
        () => awardRack(player)
    );

    $(`subtract-${n}`).addEventListener(
        "click",
        () => subtractRack(player)
    );

    $(`extension-${n}`).addEventListener(
        "click",
        () => useExtension(player)
    );

    $(`player-${n}-row`).addEventListener(
        "click",
        () => selectPlayer(player)
    );
}

$("shootout-btn").addEventListener(
    "click",
    enterShootout
);

$("exit-shootout-btn").addEventListener(
    "click",
    exitShootout
);

$("made-btn").addEventListener(
    "click",
    () => recordAttempt(true)
);

$("missed-btn").addEventListener(
    "click",
    () => recordAttempt(false)
);

window.addEventListener("pagehide", () => {
    match.remaining = getRemaining();
    saveState();
});

// ==========================================
// INITIALIZATION
// ==========================================

loadState();
populateCountries();
render();

console.log("Pool Shot Clock v0.3b initialized.");



/* Version 0.3a controls */

$("switch-btn").addEventListener(
    "click",
    switchPlayer
);


/* ==========================================
   VERSION 0.3b — PRECISION CLOCK ADJUSTMENT
   ========================================== */

let adjustmentSnapshot = null;

function openClockAdjustment() {
    if (!settings.clockEnabled) return;
    if (match.winner !== null) return;
    if (match.shootout) return;
    if ($("adjust-clock-dialog").open) return;

    adjustmentSnapshot = {
        remaining: getRemaining(),
        clockTotal: match.clockTotal,
        clockState: match.clockState,
        clockMode: match.clockMode
    };

    pauseClock();

    $("adjust-time-input").value =
        adjustmentSnapshot.remaining.toFixed(1);

    $("adjust-clock-dialog").showModal();
}

function readAdjustmentTime() {
    const input = $("adjust-time-input");

    if (input.value.trim() === "") {
        return null;
    }

    const value = Number(input.value);

    if (!Number.isFinite(value) || value < 0) {
        return null;
    }

    return Math.round(value * 10) / 10;
}

function changeAdjustment(delta) {
    const current = readAdjustmentTime();

    if (current === null) return;

    const updated = Math.max(
        0,
        Math.round((current + delta) * 10) / 10
    );

    $("adjust-time-input").value =
        updated.toFixed(1);
}

function applyClockAdjustment() {
    if (!adjustmentSnapshot) return;

    const corrected = readAdjustmentTime();

    if (corrected === null) {
        alert("Enter a valid non-negative time.");
        return;
    }

    rememberState();

    deadline = null;

    match.remaining = corrected;

    match.clockTotal = Math.max(
        adjustmentSnapshot.clockTotal,
        corrected
    );

    match.clockState =
        corrected > 0 ? "paused" : "expired";

    lastDisplayedSecond = Math.ceil(corrected);

    adjustmentSnapshot = null;

    $("adjust-clock-dialog").close();

    render();
    saveState();
}

function cancelClockAdjustment() {
    if (!adjustmentSnapshot) return;

    const snapshot = adjustmentSnapshot;

    adjustmentSnapshot = null;

    deadline = null;

    match.remaining = snapshot.remaining;
    match.clockTotal = snapshot.clockTotal;
    match.clockMode = snapshot.clockMode;

    match.clockState =
        snapshot.clockState === "running"
            ? "paused"
            : snapshot.clockState;

    lastDisplayedSecond =
        Math.ceil(snapshot.remaining);

    $("adjust-clock-dialog").close();

    if (snapshot.clockState === "running") {
        startClock();
    } else {
        render();
        saveState();
    }
}


// Clock interaction

$("clock-container").addEventListener(
    "click",
    openClockAdjustment
);

$("clock-container").addEventListener(
    "keydown",
    event => {
        if (
            event.key === "Enter" ||
            event.key === " "
        ) {
            event.preventDefault();
            openClockAdjustment();
        }
    }
);


// Increment and decrement buttons

document.querySelectorAll(
    "[data-adjust]"
).forEach(button => {
    button.addEventListener(
        "click",
        () => changeAdjustment(
            Number(button.dataset.adjust)
        )
    );
});


// Dialog actions

$("apply-adjustment").addEventListener(
    "click",
    applyClockAdjustment
);

$("cancel-adjustment").addEventListener(
    "click",
    cancelClockAdjustment
);

$("adjust-clock-dialog").addEventListener(
    "cancel",
    event => {
        event.preventDefault();
        cancelClockAdjustment();
    }
);

$("adjust-time-input").addEventListener(
    "keydown",
    event => {
        if (event.key === "Enter") {
            event.preventDefault();
            applyClockAdjustment();
        }
    }
);

// v0.7.3 — PWA update manager

if ("serviceWorker" in navigator && window.isSecureContext) {
    let registration = null;
    let previousController = navigator.serviceWorker.controller;
    let checkingForUpdate = false;

    function showUpdateButton() {
        if (document.getElementById("pwa-update-btn")) return;

        const button = document.createElement("button");

        button.id = "pwa-update-btn";
        button.textContent = "Update available — Tap to reload";

        Object.assign(button.style, {
            position: "fixed",
            bottom: "12px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: "9999",
            background: "#28b84b",
            color: "#ffffff",
            border: "none",
            borderRadius: "8px",
            padding: "12px 20px",
            fontSize: "15px",
            fontWeight: "700",
            whiteSpace: "nowrap",
            boxShadow: "0 4px 20px #0008"
        });

        button.addEventListener("click", () => {
            if (match.clockState === "running") {
                if (!confirm("Pause the clock and update?")) return;
                pauseClock();
            }

            saveState();
            window.location.reload();
        });

        document.body.appendChild(button);
    }

    async function checkForUpdate() {
        if (!registration || checkingForUpdate) return;
        if (!navigator.onLine) return;

        checkingForUpdate = true;

        try {
            await registration.update();
            console.log("Update check completed.");
        } catch (error) {
            console.warn("Update check failed:", error);
        } finally {
            checkingForUpdate = false;
        }
    }

    navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
            const controller = navigator.serviceWorker.controller;

            if (previousController &&
                controller !== previousController) {
                showUpdateButton();
            }

            previousController = controller;
        }
    );

    window.addEventListener("load", async () => {
        try {
            registration = await navigator.serviceWorker.register(
                "./sw.js",
                { updateViaCache: "none" }
            );

            await checkForUpdate();

            console.log("PWA update manager ready.");
        } catch (error) {
            console.warn("PWA registration failed:", error);
        }
    });

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            checkForUpdate();
        }
    });

    window.addEventListener("online", checkForUpdate);
}

// v0.7.3 — Prevent landscape rubber-banding

document.addEventListener("touchmove", (event) => {
    const landscape = window.matchMedia(
        "(orientation: landscape)"
    ).matches;

    if (!landscape) return;

    const dialog = event.target.closest("dialog");

    if (dialog && dialog.open) return;

    if (event.target.closest("#attempts-1, #attempts-2")) return;

    // Allow normal touch interaction with controls.
    if (event.target.closest(
        "button, input, select, textarea, [role='button']"
    )) return;


    if (event.cancelable) {
        event.preventDefault();
    }
}, { passive: false });



$("shootout-undo-btn").addEventListener("click", () => {
    $("undo-btn").click();
});
