document.addEventListener('DOMContentLoaded', () => {

    // ==========================================
    // 1. CONSTANTS & GLOBAL STATE
    // ==========================================
    // The Google Doc schedule is the single source of truth for show/DJ names.
    // Tabs of the Google Sheet: "Schedule" (the shows) and "Residents". If you rename a tab,
    // change its name here too.
    const SHEET_URL = 'https://opensheet.elk.sh/1OhiyukdiE9ZdmLHTI0nnnKosPXwnOXUJ4t5uh5c4HYE/Schedule';

    const SCHEDULE_MAX_AGE_MS = 10 * 60 * 1000; // re-fetch the sheet at most every 10 minutes
    const PAST_SHOWS_PAGE = 24;                  // how many past shows to show at a time

    let masterScheduleData = [];
    let scheduleFetchedAt = 0;
    let schedulePromise = null;
    let scheduleError = false;
    let chatInitialized = false;
    // What the on-air bar shows right now; the home page's bowl follows it
    let stripNow = { state: 'offline', label: 'off air', bowl: { letters: 'BRODO', title: 'the broth is resting', meta: '' } };

    // Past shows (Mixcloud) and residents (the sheet's Residents tab), see section 7
    const MIXCLOUD_URL = 'https://api.mixcloud.com/radiomantis/cloudcasts/?limit=100';
    const RESIDENTS_URL = SHEET_URL.replace(/\/[^/]+$/, '/Residents');

    // Used until the Residents tab exists in the sheet. Same columns as the tab.
    const RESIDENTS_FALLBACK = [
        { Name: 'Bee Suave',   Slug: 'beesuave',    City: 'Turin',       Aliases: 'bee suave, beesuave, sangwich' },
        { Name: 'biancah',     Slug: 'biancah',     City: 'São Paulo',   Aliases: 'biancah, bianca abad' },
        { Name: 'darbydarby',  Slug: 'darbydarby',  City: 'New York',    Aliases: 'darbydarby, critical conditioner' },
        { Name: 'Fodongophon', Slug: 'fodongophon', City: 'Hamburg',     Aliases: 'fodongophon, trip recovery service, sunday service, kraüt & ruben, kraut ruben, krautruben' },
        { Name: 'heatsink',    Slug: 'heatsink',    City: 'Los Angeles', Aliases: 'heatsink, rhythmism' },
        { Name: 'luca',        Slug: 'luca',        City: 'São Paulo',   Aliases: 'luca' },
        { Name: 'shweiri',     Slug: 'shweiri',     City: 'Boston',      Aliases: 'shweiri, dj shweiri, watercast' },
        { Name: 'Sideroom',    Slug: 'sideroom',    City: 'Bangalore',   Aliases: 'sideroom, side room, in too deep' },
        { Name: 'splenda',     Slug: 'splenda',     City: 'Los Angeles', Aliases: 'splenda, wyd' },
    ];

    let archive = [];              // every Mixcloud upload, newest first
    let archivePromise = null;
    let residents = null;          // normalised resident records
    let residentsPromise = null;
    let pastShowsShown = 0;        // how many cards the past-shows page is showing

    let dockKey = null;           // the Mixcloud key of the show in the dock
    let archiveFilter = { slug: '', q: '' };   // the archive page's resident filter and search
    let widget = null;            // Mixcloud widget API object, when available
    let widgetApiPromise = null;
    // Past shows are cached for the whole visit, so going back to the page doesn't refetch.


    // ==========================================
    // 2. INITIALIZATION
    // ==========================================

    initOnce();
    init();

    // Poll now-playing every 15s, but not while the tab is in the background.
    setInterval(() => {
        if (document.visibilityState === 'visible') updateRadioData();
    }, 15000);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') updateRadioData();
    });

    // Things outside #app-frame (strip, header, footer, chat): set up once per visit
    function initOnce() {
        initLinks(document.querySelector('.site-header'));
        initLinks(document.querySelector('.site-footer'));
        initMenu();
        initAudioPlayer();
        initDock();
        initChat();
        updateRadioData();
    }

    // Things inside #app-frame: set up again after every page change
    function init() {
        initLinks(document.getElementById('app-frame'));
        setCurrentNav();
        setTimezoneNote();
        renderBowl();
        loadGlobalSchedule();
        loadPastShows();
        loadLatestShows();
        loadHomeResidents();
        loadResidentsGrid();
        loadResidentPage();
    }

    // Underline the menu link for the page we're on
    function setCurrentNav() {
        const here = normalizePath(window.location.pathname);
        document.querySelectorAll('.site-nav a.nav-link[href^="/"]').forEach((link) => {
            if (normalizePath(new URL(link.href).pathname) === here) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
    }
    function normalizePath(path) {
        if (/^\/resident(\.html)?$/.test(path)) return '/residents';
        return path.replace(/\/index\.html$/, '/').replace(/\.html$/, '').replace(/(.)\/$/, '$1') || '/';
    }

    // Mobile menu
    function initMenu() {
        const toggle = document.getElementById('menu-toggle');
        const nav = document.getElementById('site-nav');
        if (!toggle || !nav) return;
        toggle.addEventListener('click', () => setMenuOpen(!nav.classList.contains('is-open')));
        nav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenuOpen(false); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && nav.classList.contains('is-open')) { setMenuOpen(false); toggle.focus(); }
        });
    }
    function setMenuOpen(open) {
        const toggle = document.getElementById('menu-toggle');
        const nav = document.getElementById('site-nav');
        if (!toggle || !nav) return;
        nav.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }

    // ==========================================
    // 3. RADIO PLAYER FUNCTIONS
    // ==========================================

    // Every control marked data-live-toggle plays or pauses the live stream: the bar's
    // button, the bowl on the home page and its "listen live" button. One listener on the
    // document covers them, including the ones that come and go with page changes.
    function initAudioPlayer() {
        const audioStream = document.getElementById('radio-stream');
        if (!audioStream) return;

        // Remember the stream URL across SPA navigations, since pausing removes the src attribute
        if (audioStream.src) audioStream.dataset.stream = audioStream.src;

        syncPlayButton();
        document.addEventListener('click', (e) => {
            if (e.target.closest('[data-live-toggle]')) toggleLive();
        });
    }

    function toggleLive() {
        const audioStream = document.getElementById('radio-stream');
        if (!audioStream) return;
        if (audioStream.paused) {
            pauseArchived(); // one thing at a time
            // Re-attach the stream URL right BEFORE playing to guarantee the live edge
            audioStream.src = audioStream.dataset.stream;
            audioStream.load();
            audioStream.play()
                .catch((err) => console.error("Couldn't start the stream:", err))
                .finally(syncPlayButton);
        } else {
            audioStream.pause();
            // Wipe the source so the browser stops downloading dead data
            audioStream.removeAttribute('src');
            audioStream.load();
        }
        syncPlayButton();
    }

    // Keep every play control's look and screen-reader label in step with the audio
    function syncPlayButton() {
        const audioStream = document.getElementById('radio-stream');
        if (!audioStream) return;
        const playing = !audioStream.paused;
        document.querySelectorAll('[data-live-toggle]').forEach((button) => {
            button.classList.toggle('is-playing', playing);
            if (button.classList.contains('btn')) button.textContent = playing ? 'pause' : 'listen live';
            else button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        });
        document.documentElement.toggleAttribute('data-playing', playing);
    }

    // The top bar follows one rule:
    //  - on a date in the schedule sheet (from the first show until the last one ends):
    //    "on air", with the show playing now or "next live: <show>, 18:00" between shows.
    //    It never flips to off air in the gaps between back-to-back sets.
    //  - any other date: "off air" and "next live on 25th of October, 2026".
    // If a DJ connects to AzuraCast outside the schedule, the bar shows them as on air too.
    let azuracastLive = null;      // { name } while a DJ is connected, else null

    async function updateRadioData() {
        if (!document.getElementById('onair')) return;
        try {
            const response = await fetch('https://radiomantis.com/api/nowplaying/2', { cache: 'no-store' });
            const radioData = await response.json();
            azuracastLive = (radioData.live && radioData.live.is_live)
                ? { name: radioData.live.streamer_name || '' } : null;
        } catch (error) {
            console.error("Couldn't fetch radio data.", error);
            azuracastLive = null;
        }
        renderStrip();
    }

    function renderStrip() {
        const upcoming = getUpcomingShows(10, 120);
        const current = upcoming.find((o) => o.live);
        const today = upcoming.filter((o) => o.live || isToday(o.start));

        if (azuracastLive || today.length) {
            let text;
            let bowl;
            if (current) {
                text = showLabel(current.show);
                bowl = {
                    letters: current.show.Show || current.show.DJ || '',
                    title: current.show.Show || current.show.DJ || '',
                    meta: `${current.show.Show && current.show.DJ ? `w/ ${current.show.DJ} · ` : ''}${timeOf(current.start)} – ${timeOf(current.end)}`,
                };
            } else if (azuracastLive && azuracastLive.name) {
                text = azuracastLive.name;
                bowl = { letters: azuracastLive.name, title: azuracastLive.name, meta: 'live now' };
            } else {
                const next = today.find((o) => !o.live);
                text = next ? `next live: ${showLabel(next.show)}, ${timeOf(next.start)}` : '';
                bowl = { letters: 'BRODO', title: 'warming up', meta: next ? `next: ${showLabel(next.show)}, ${timeOf(next.start)}` : '' };
            }
            setStripState('live', 'on air', text.toLowerCase(), bowl);
            setMediaSession(current ? current.show : null, azuracastLive && azuracastLive.name);
            return;
        }

        // Not a broadcast date. Only stop a listener's stream once we actually know the
        // schedule (so a slow or failed sheet never cuts anyone off).
        if (scheduleFetchedAt) stopLive();
        const text = upcoming.length ? `next live on ${longDate(upcoming[0].start)}` : '';
        setStripState('offline', 'off air', text, { letters: 'BRODO', title: 'the broth is resting', meta: text });
    }

    // ---- the bowl on the home page ----
    // The show's name floats in the broth as alphabet pasta. Off air it spells BRODO and
    // stays still; while live the letters drift and bubbles rise.
    function renderBowl() {
        const bowl = document.getElementById('bowl');
        if (!bowl) return;
        const live = stripNow.state === 'live';
        const info = stripNow.bowl || {};
        bowl.classList.toggle('is-live', live);

        const status = document.getElementById('bowl-status');
        const statusLabel = document.getElementById('bowl-status-label');
        if (status && statusLabel) {
            status.className = 'pill ' + (live ? 'pill--live' : 'pill--off');
            statusLabel.textContent = live ? 'on air' : 'off air';
        }
        const title = document.getElementById('bowl-show');
        if (title) title.textContent = (info.title || '').toLowerCase();
        const meta = document.getElementById('bowl-meta');
        if (meta) meta.textContent = info.meta || '';
        ['bowl-play', 'hero-listen'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.hidden = !live;
        });

        const broth = document.getElementById('bowl-broth');
        const letters = String(info.letters || 'BRODO').normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 16) || 'BRODO';
        if (broth && broth.dataset.letters !== letters + live) {
            broth.dataset.letters = letters + live;
            broth.textContent = '';
            // Scatter the letters on a spiral round the play button, each tilted a little.
            // A fixed seed, so the same show always lands the same way.
            let seed = 11;
            const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
            const fewer = letters.length <= 6;   // short words sit a bit closer in and bigger
            [...letters].forEach((ch, i) => {
                const angle = i * 2.39996 + 0.6;
                const radius = (fewer ? 0.21 : 0.205) + (i % 3) * 0.05 + rnd() * 0.025;
                const s = document.createElement('span');
                s.className = 'letter';
                s.textContent = ch;
                s.style.left = `${50 + Math.cos(angle) * radius * 100 / 0.82}%`;
                s.style.top = `${50 + Math.sin(angle) * radius * 100 / 0.82}%`;
                s.style.fontSize = `${(((fewer ? 0.088 : 0.072) + rnd() * 0.026) * 100).toFixed(2)}cqw`;   // a share of the bowl's width
                s.style.setProperty('--r', `${Math.round(rnd() * 70 - 35)}deg`);
                s.style.animationDelay = `${(-rnd() * 7).toFixed(2)}s`;
                broth.appendChild(s);
            });
            if (live) {
                for (let j = 0; j < 6; j++) {
                    const b = document.createElement('span');
                    const d = 4 + Math.round(rnd() * 6);
                    b.className = 'bubble';
                    b.style.width = b.style.height = `${d}px`;
                    b.style.left = `${18 + rnd() * 64}%`;
                    b.style.top = `${40 + rnd() * 45}%`;
                    b.style.animationDelay = `${(-rnd() * 3.2).toFixed(2)}s`;
                    broth.appendChild(b);
                }
            }
        }
        syncPlayButton();
    }

    // Lock-screen / headphone controls info
    function setMediaSession(show, streamer) {
        if (!('mediaSession' in navigator)) return;
        const host = (show && show.DJ) || streamer || 'Radio Brodo';
        navigator.mediaSession.metadata = new MediaMetadata({
            title: (show && (show.Show || show.DJ)) || streamer || 'Radio Brodo',
            artist: show && show.Show ? host : 'Radio Brodo',
            artwork: [{ src: '/css/pictures/maskable-icon.png', sizes: '512x512', type: 'image/png' }],
        });
    }

    function stopLive() {
        const audioStream = document.getElementById('radio-stream');
        if (audioStream && !audioStream.paused) {
            audioStream.pause();
            audioStream.removeAttribute('src');
            audioStream.load();
        }
        syncPlayButton();
    }

    // "18:00" in the listener's timezone
    function timeOf(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, numberingSystem: 'latn' });
    }

    // The strip's colour and dot follow the state: live or offline
    function setStripState(state, label, text, bowl) {
        stripNow = { state, label, bowl };
        renderBowl();
        const strip = document.getElementById('onair');
        const playButton = document.getElementById('play-pause-btn');
        const statusLabel = document.getElementById('status-label');
        const mainText = document.getElementById('main-player-text');
        if (!strip || !playButton || !statusLabel || !mainText) return;
        strip.dataset.state = state;
        playButton.hidden = state === 'offline';
        const pill = statusLabel.closest('.onair-status');
        if (pill) pill.hidden = !label;
        if (statusLabel.textContent !== label) statusLabel.textContent = label;
        mainText.textContent = text;
        mainText.title = text;
    }

    // "sangwich show w/ splenda", or just the DJ when there's no show name
    function showLabel(show) {
        return show.Show ? `${show.Show} w/ ${show.DJ || ''}`.trim() : (show.DJ || '');
    }

    // "today 18:00", "tomorrow 21:00", "friday 20:00" in the listener's timezone
    function formatWhen(date) {
        const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, numberingSystem: 'latn' });
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const that = new Date(date); that.setHours(0, 0, 0, 0);
        const days = Math.round((that - today) / 86400000);
        if (days === 0) return `today ${time}`;
        if (days === 1) return `tomorrow ${time}`;
        if (days === -1) return `yesterday ${time}`;
        if (days > 1 && days < 7) return `${date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase()} ${time}`;
        // further away: "sun 6 dec 18:00", so it can't be mistaken for this week
        const month = date.toLocaleDateString('en-US', { month: 'short' }).toLowerCase();
        return `${shortDay(date)} ${month} ${time}`;
    }

    // ==========================================
    // 4. SCHEDULE FUNCTIONS
    // ==========================================
    // Fetches the sheet once and reuses it across page changes; refreshes when older
    // than SCHEDULE_MAX_AGE_MS. Concurrent callers share one request.
    function loadGlobalSchedule() {
        const fresh = scheduleFetchedAt && (Date.now() - scheduleFetchedAt < SCHEDULE_MAX_AGE_MS);
        if (fresh) {
            renderScheduleViews();
            return Promise.resolve(masterScheduleData);
        }
        if (!schedulePromise) {
            schedulePromise = fetch(SHEET_URL)
                .then((response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.json();
                })
                .then((rows) => {
                    masterScheduleData = Array.isArray(rows) ? rows : [];
                    scheduleFetchedAt = Date.now();
                    scheduleError = false;
                    // The bar may have been drawn before the sheet arrived; redraw it now
                    renderStrip();
                })
                .catch((error) => {
                    scheduleError = true;
                    console.error("Schedule fetch error:", error);
                })
                .finally(() => { schedulePromise = null; });
        }
        return schedulePromise.then(() => {
            // Draw whatever schedule views this page has, now that we have data
            renderScheduleViews();
            return masterScheduleData;
        });
    }

    function renderScheduleViews() {
        if (document.getElementById('up-next-list')) renderUpNext();
    }

    // Every scheduled slot between two day offsets (from today in Copenhagen), as real
    // moments in time, sorted. Sheet times are Copenhagen wall-clock (see cphWallToDate).
    function getOccurrences(fromOffset, toOffset) {
        const now = new Date();
        const cph = getNowInCopenhagen();
        const occurrences = [];
        for (let offset = fromOffset; offset <= toOffset; offset++) {
            const day = new Date(cph.getFullYear(), cph.getMonth(), cph.getDate() + offset);
            const y = day.getFullYear(), m = day.getMonth(), d = day.getDate();
            const dayName = day.toLocaleDateString('en-US', { weekday: 'long' });
            const dateString = localDateString(day);
            masterScheduleData.forEach((show) => {
                if (!show.Start || !show.End) return;
                const dated = show.Date && show.Date.trim() !== '';
                if (dated ? show.Date !== dateString : show.Day !== dayName) return;
                const [sh, sm] = show.Start.split(':').map(Number);
                const [eh, em] = show.End.split(':').map(Number);
                const start = cphWallToDate(y, m, d, sh, sm);
                // An end at or before the start (23:00–01:00, 22:00–00:00) is the next morning
                const endsNextDay = eh * 60 + em <= sh * 60 + sm;
                const end = cphWallToDate(y, m, d + (endsNextDay ? 1 : 0), eh, em);
                occurrences.push({ show, start, end, live: start <= now && end > now, past: end <= now });
            });
        }
        occurrences.sort((a, b) => a.start - b.start);
        return occurrences;
    }

    // Shows that haven't finished yet, from yesterday up to `days` ahead
    function getUpcomingShows(limit = 3, days = 7) {
        const now = new Date();
        return getOccurrences(-1, days).filter((o) => o.end > now).slice(0, limit);
    }

    // Every show this week, Monday to Sunday in the listener's timezone, finished ones included
    function getThisWeekShows() {
        const monday = new Date();
        monday.setHours(0, 0, 0, 0);
        monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
        const nextMonday = new Date(monday);
        nextMonday.setDate(monday.getDate() + 7);
        return getOccurrences(-8, 8).filter((o) => o.start >= monday && o.start < nextMonday);
    }

    // Home: "this week's menu". In a week with a show, that whole week, grouped by day,
    // like a trattoria menu: show, dotted leader, time. Otherwise (or once this week's
    // last show has ended), "next on the menu" and the date of the next live.
    function renderUpNext() {
        const list = document.getElementById('up-next-list');
        if (!list) return;
        list.textContent = '';
        const title = document.getElementById('up-next-title');
        const sub = document.getElementById('tz-note');
        const week = getThisWeekShows();
        const liveWeek = week.some((o) => !o.past);
        if (title) title.textContent = liveWeek ? "this week's menu" : 'next on the menu';
        const heroLink = document.getElementById('hero-menu-link');
        if (heroLink) heroLink.textContent = liveWeek ? "this week's menu" : 'next on the menu';
        if (sub) {
            sub.hidden = !liveWeek;
            if (liveWeek) sub.textContent = `${weekRange()} · times in your timezone (${tzAbbr().toLowerCase()})`;
        }

        if (!liveWeek) {
            const next = getUpcomingShows(1, 120)[0];   // look up to four months ahead
            const p = document.createElement('p');
            if (next) {
                p.className = 'menu-next';
                p.textContent = longDate(next.start);
            } else {
                p.className = 'menu-empty';
                p.textContent = scheduleError
                    ? "Couldn't load the schedule. Try again in a minute."
                    : 'No shows scheduled yet. Follow us on Instagram for new dates.';
            }
            list.appendChild(p);
            return;
        }

        let lastDay = '';
        week.forEach(({ show, start, live, past }) => {
            const day = shortDay(start);
            if (day !== lastDay) {
                const d = document.createElement('p');
                d.className = 'menu-day';
                d.textContent = day;
                list.appendChild(d);
                lastDay = day;
            }
            const row = document.createElement('div');
            row.className = 'menu-row' + (live ? ' is-live' : '') + (past ? ' is-past' : '');
            const what = document.createElement('span');
            what.className = 'menu-what';
            what.textContent = show.Show || show.DJ || '';
            if (show.Show && show.DJ) {
                const dj = document.createElement('span');
                dj.className = 'menu-dj';
                dj.textContent = ` w/ ${show.DJ}`;
                what.appendChild(dj);
            }
            const lead = document.createElement('span');
            lead.className = 'menu-lead';
            lead.setAttribute('aria-hidden', 'true');
            const time = document.createElement('span');
            time.className = 'menu-time';
            time.textContent = live ? 'now' : timeOf(start);
            row.append(what, lead, time);
            list.appendChild(row);
        });
    }

    // "wed 18" in the listener's timezone
    function shortDay(date) {
        return `${date.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase()} ${date.getDate()}`;
    }
    // "16 – 22 november" (or "30 november – 6 december") for this Monday to Sunday
    function weekRange() {
        const monday = new Date();
        monday.setHours(0, 0, 0, 0);
        monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        const month = (d) => d.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
        return monday.getMonth() === sunday.getMonth()
            ? `${monday.getDate()} – ${sunday.getDate()} ${month(sunday)}`
            : `${monday.getDate()} ${month(monday)} – ${sunday.getDate()} ${month(sunday)}`;
    }
    function tzAbbr() {
        return new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
    }

    // Is this moment on today's date, in the listener's timezone?
    function isToday(date) {
        const now = new Date();
        return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
            && date.getDate() === now.getDate();
    }

    // "25th of October, 2026" in the listener's timezone
    function longDate(date) {
        const d = date.getDate();
        const suffix = (d % 100 >= 11 && d % 100 <= 13) ? 'th'
            : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th');
        const month = date.toLocaleDateString('en-US', { month: 'long' });
        return `${d}${suffix} of ${month}, ${date.getFullYear()}`;
    }

    // Under "up next": say which timezone the times are in
    function setTimezoneNote() {
        const tzNote = document.getElementById('tz-note');
        if (!tzNote) return;
        const abbr = new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
        tzNote.textContent = `Times are in your timezone (${abbr}).`;
    }

    // ==========================================
    // 5. UTILITY FUNCTIONS
    // ==========================================

    // "2026-04-06" from a Date's local fields
    function localDateString(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // The schedule sheet's Start/End are Europe/Copenhagen wall-clock times. These helpers
    // convert them to the viewer's local timezone, correctly across DST (CET vs CEST).

    // Minutes to ADD to a UTC instant to get the wall-clock time in `tz`.
    function tzOffsetMinutes(date, tz) {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const p = {};
        for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
        const hour = p.hour === '24' ? 0 : Number(p.hour);
        const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
        return (asUTC - date.getTime()) / 60000;
    }

    // Absolute Date for a Copenhagen wall-clock time on a given calendar day.
    function cphWallToDate(year, monthIndex, day, hh, mm) {
        const guessUTC = Date.UTC(year, monthIndex, day, hh, mm);
        const offset = tzOffsetMinutes(new Date(guessUTC), 'Europe/Copenhagen');
        return new Date(guessUTC - offset * 60000);
    }
// The current time in the radio's timezone. Both schedule lookups key off this.
    function getNowInCopenhagen() {
        return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Copenhagen" }));
    }


 
    // ==========================================
    // 6. NAVIGATION
    // ==========================================

    window.addEventListener("popstate", () => loadPage({ focus: false }));

    // Swap #app-frame for the new page's, so the <audio> and chat outside it keep going.
    async function loadPage({ focus = true } = {}) {
        const url = window.location.href;
        let newDocument;
        try {
            // Always check with the server: a browser's saved copy of a page can be
            // from an older version of the site and would mix old content into the new layout
            const response = await fetch(url, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const html = await response.text();
            newDocument = new DOMParser().parseFromString(html, 'text/html');
        } catch (error) {
            // Anything unexpected: fall back to a normal page load
            window.location.href = url;
            return;
        }
        const newFrame = newDocument.querySelector("#app-frame");
        if (newFrame === null) {
            window.location.href = url;
            return;
        }
        const oldFrame = document.querySelector("#app-frame");
        oldFrame.replaceWith(document.importNode(newFrame, true));
        document.title = newDocument.title;
        document.documentElement.dataset.page = newDocument.documentElement.dataset.page || '';
        init();

        if (focus) {
            window.scrollTo(0, 0);
            // Move keyboard / screen-reader focus to the new page's heading
            const heading = document.querySelector('#app-frame h1') || document.getElementById('app-frame');
            if (heading) {
                heading.setAttribute('tabindex', '-1');
                heading.focus({ preventScroll: true });
            }
        }
    }

    // ==========================================
    // 7. ARCHIVE, RESIDENTS AND THE SHOW PLAYER
    // ==========================================
    // Past shows come from Mixcloud. Residents come from the "Residents" tab of the
    // schedule sheet (falling back to the list below until that tab exists). A show
    // belongs to every resident whose name (or one of their aliases) appears in its
    // title, so b2b shows land on both pages.

    // "Kraüt & Ruben!" -> "kraut ruben": lower case, no accents, words only
    function normalize(text) {
        return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }
    function containsName(text, alias) {
        return alias && (' ' + normalize(text) + ' ').includes(' ' + alias + ' ');
    }

    // ---- data ----

    function loadArchive() {
        if (archivePromise) return archivePromise;
        archivePromise = (async () => {
            let url = MIXCLOUD_URL;
            const all = [];
            for (let page = 0; url && page < 20; page++) {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                if (Array.isArray(data.data)) all.push(...data.data);
                url = (data.paging && data.paging.next) || null;
            }
            archive = all;
            return archive;
        })().catch((error) => {
            archivePromise = null;          // allow a retry on the next page view
            throw error;
        });
        return archivePromise;
    }

    function loadResidents() {
        if (residentsPromise) return residentsPromise;
        residentsPromise = fetch(RESIDENTS_URL)
            .then((response) => (response.ok ? response.json() : null))
            .catch(() => null)
            .then((rows) => {
                const usable = Array.isArray(rows) ? rows.filter((r) => r && r.Name && String(r.Name).trim()) : [];
                residents = (usable.length ? usable : RESIDENTS_FALLBACK).map(toResident);
                return residents;
            });
        return residentsPromise;
    }

    function toResident(row) {
        const name = String(row.Name).trim();
        const slug = normalize(row.Slug || name).replace(/ /g, '');
        const aliases = String(row.Aliases || '').split(',').map(normalize).filter(Boolean);
        if (!aliases.includes(normalize(name))) aliases.unshift(normalize(name));
        const photo = String(row.Photo || '').trim();
        return {
            name, slug, aliases,
            city: String(row.City || '').trim(),
            photo: !photo ? `css/pictures/residents/${slug}.avif`
                : /^https?:\/\//.test(photo) || photo.includes('/') ? photo : `css/pictures/residents/${photo}`,
            instagram: profileUrl(row.Instagram, 'https://www.instagram.com/'),
            mixcloud: profileUrl(row.Mixcloud, 'https://www.mixcloud.com/'),
            bio: String(row.Bio || '').trim(),
        };
    }
    // Accept "@handle", "handle" or a full link
    function profileUrl(value, base) {
        const v = String(value || '').trim();
        if (!v) return '';
        if (/^https?:\/\//.test(v)) return v;
        return base + v.replace(/^@/, '').replace(/^\/+|\/+$/g, '') + '/';
    }

    // Which residents host this upload / schedule row?
    function hostsOf(text) {
        if (!residents) return [];
        return residents.filter((r) => r.aliases.some((a) => containsName(text, a)));
    }

    // ---- show cards ----

    // "Rhythmism w/ heatsink - 27 September 2026" -> title "Rhythmism", date "27 September 2026"
    function splitTitle(name) {
        const [main, ...rest] = String(name || '').split(' - ');
        const date = rest.join(' - ');
        const title = main.split(/\s+(?:w\/|with)\s+/i)[0].trim() || main.trim();
        return { title, date };
    }

    // One card, built with textContent so show names can't inject HTML.
    // The artwork plays the show in the player; host names link to resident pages.
    function buildShowCard(show) {
        const { title, date } = splitTitle(show.name);
        const hosts = hostsOf(show.name);

        const card = document.createElement('article');
        card.className = 'show-item';
        if (show.key) card.dataset.key = show.key;
        if (show.key && show.key === dockKey) card.classList.add('is-playing');

        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'show-play';
        play.setAttribute('aria-label', `Play ${show.name}`);
        const img = document.createElement('img');
        img.src = show.pictures ? (show.pictures.large || show.pictures.medium || '') : '';
        img.alt = '';
        img.loading = 'lazy';
        play.appendChild(img);
        play.addEventListener('click', () => playArchived(show));

        const heading = document.createElement('p');
        heading.className = 'show-title';
        heading.textContent = hosts.length ? title : (show.name || '').split(' - ')[0];
        card.append(play, heading);

        if (hosts.length) {
            const by = document.createElement('div');
            by.className = 'show-hosts';
            by.append('w/ ');
            hosts.forEach((r, i) => {
                if (i) by.append(i === hosts.length - 1 ? ' & ' : ', ');
                const a = document.createElement('a');
                a.href = `/resident?r=${encodeURIComponent(r.slug)}`;
                a.textContent = r.name;
                by.appendChild(a);
            });
            card.appendChild(by);
        }
        if (date) {
            const d = document.createElement('div');
            d.className = 'show-date';
            d.textContent = date;
            card.appendChild(d);
        }
        initLinks(card);
        return card;
    }

    function showMessage(container, text) {
        container.textContent = '';
        const p = document.createElement('p');
        p.className = 'past-shows-loading';
        p.textContent = text;
        container.appendChild(p);
    }

    // ---- past shows page ----

    async function loadPastShows() {
        const container = document.getElementById('past-shows-container');
        if (!container) return;
        if (!archive.length) showMessage(container, 'loading shows…');
        try {
            await Promise.all([loadArchive(), loadResidents()]);
        } catch (error) {
            console.error("Couldn't fetch past shows from Mixcloud:", error);
            if (document.getElementById('past-shows-container') === container)
                showMessage(container, "Couldn't load past shows. Listen back on our Mixcloud page instead.");
            return;
        }
        if (document.getElementById('past-shows-container') !== container) return;
        container.textContent = '';
        if (!archive.length) { showMessage(container, 'No past shows yet.'); return; }
        initArchiveTools(container);
        renderArchive(container);
    }

    // Search box and one chip per resident (plus "all"). Both narrow the same list.
    function initArchiveTools(container) {
        const search = document.getElementById('archive-search');
        const chips = document.getElementById('archive-filters');
        if (search) {
            search.value = archiveFilter.q;
            search.addEventListener('input', () => {
                archiveFilter.q = search.value;
                renderArchive(container);
            });
        }
        if (chips) {
            chips.textContent = '';
            const options = [{ slug: '', name: 'all' }, ...residents.filter((r) => archive.some((s) => hostsOf(s.name).includes(r)))];
            options.forEach((r) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'chip';
                b.textContent = r.name;
                b.setAttribute('aria-pressed', String(archiveFilter.slug === r.slug));
                b.addEventListener('click', () => {
                    archiveFilter.slug = r.slug;
                    chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
                    renderArchive(container);
                });
                chips.appendChild(b);
            });
        }
    }

    function filteredArchive() {
        const q = normalize(archiveFilter.q);
        const who = archiveFilter.slug && residents ? residents.find((r) => r.slug === archiveFilter.slug) : null;
        return archive.filter((show) => {
            if (who && !hostsOf(show.name).includes(who)) return false;
            if (q && !normalize(show.name).includes(q)) return false;
            return true;
        });
    }

    function renderArchive(container) {
        container.textContent = '';
        pastShowsShown = 0;
        const old = document.getElementById('past-shows-more');
        if (old) old.remove();
        if (!filteredArchive().length) { showMessage(container, 'Nothing in the pot matches that. Try another name.'); return; }
        showMorePastShows(container);
    }

    function showMorePastShows(container) {
        const list = filteredArchive();
        list.slice(pastShowsShown, pastShowsShown + PAST_SHOWS_PAGE)
            .forEach((show) => container.appendChild(buildShowCard(show)));
        pastShowsShown = Math.min(list.length, pastShowsShown + PAST_SHOWS_PAGE);
        const old = document.getElementById('past-shows-more');
        if (old) old.remove();
        if (pastShowsShown >= list.length) return;
        const button = document.createElement('button');
        button.id = 'past-shows-more';
        button.type = 'button';
        button.className = 'btn btn--line past-shows-more';
        button.textContent = 'more from the pot';
        button.addEventListener('click', () => showMorePastShows(container));
        container.after(button);
    }

    // ---- home: the four newest ----

    async function loadLatestShows() {
        const container = document.getElementById('latest-shows');
        if (!container) return;
        try {
            await Promise.all([loadArchive(), loadResidents()]);
        } catch (error) {
            console.error("Couldn't fetch latest shows from Mixcloud:", error);
        }
        if (document.getElementById('latest-shows') !== container) return;
        container.textContent = '';
        if (!archive.length) {
            const p = document.createElement('p');
            p.textContent = 'Listen back to past shows on our Mixcloud page.';
            container.appendChild(p);
            return;
        }
        archive.slice(0, 4).forEach((show) => container.appendChild(buildShowCard(show)));
    }

    // ---- residents page ----

    // A resident's face in a bowl, name and city: used on the home page and the residents page
    function residentLink(r, className) {
        const a = document.createElement('a');
        a.className = className;
        a.href = `/resident?r=${encodeURIComponent(r.slug)}`;
        const img = document.createElement('img');
        img.className = className === 'person' ? 'person-face' : 'resident-face';
        img.src = r.photo; img.alt = ''; img.loading = 'lazy'; img.width = 1000; img.height = 1334;
        const text = document.createElement('span');
        text.className = 'resident-card-text';
        const n = document.createElement('span'); n.className = 'resident-name'; n.textContent = r.name;
        const c = document.createElement('span'); c.className = 'resident-place'; c.textContent = r.city;
        text.append(n, c);
        a.append(img, text);
        return a;
    }

    // Home: six residents, and the counts in "what's in the pot"
    async function loadHomeResidents() {
        const grid = document.getElementById('home-residents');
        if (!grid) return;
        await loadResidents();
        if (document.getElementById('home-residents') !== grid) return;
        grid.textContent = '';
        residents.slice(0, 6).forEach((r) => grid.appendChild(residentLink(r, 'person')));
        initLinks(grid);

        const cities = new Set(residents.map((r) => normalize(r.city)).filter(Boolean)).size;
        const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
        const say = (n) => words[n] || String(n);
        const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        setText('fact-residents', String(residents.length));
        setText('fact-cities', String(cities));
        const intro = `${say(residents.length)} residents, ${say(cities)} cities, one pot.`;
        setText('ingredients-intro', intro.charAt(0).toUpperCase() + intro.slice(1));
    }

    async function loadResidentsGrid() {
        const grid = document.getElementById('residents-grid');
        if (!grid) return;
        await loadResidents();
        if (document.getElementById('residents-grid') !== grid) return;
        grid.textContent = '';
        const cards = residents.map((r) => {
            const card = residentLink(r, 'resident-card');
            grid.appendChild(card);
            return { r, card };
        });
        initLinks(grid);

        // Who's on air now, or on the menu in the next four weeks
        await loadGlobalSchedule();
        if (document.getElementById('residents-grid') !== grid) return;
        const upcoming = getUpcomingShows(200, 28);
        cards.forEach(({ r, card }) => {
            const next = upcoming.find((o) => hostsOf(`${o.show.DJ || ''} ${o.show.Show || ''}`).includes(r));
            if (!next) return;
            const text = card.querySelector('.resident-card-text');
            if (next.live) {
                const pill = document.createElement('span');
                pill.className = 'pill pill--live';
                const dot = document.createElement('span'); dot.className = 'pill-dot';
                pill.append(dot, 'on air now');
                text.appendChild(pill);
            } else {
                const soon = document.createElement('span');
                soon.className = 'resident-soon';
                soon.textContent = `${next.show.Show ? next.show.Show + ', ' : ''}${formatWhen(next.start)}`;
                text.appendChild(soon);
            }
        });
    }

    // ---- one resident's page: /resident?r=heatsink ----

    async function loadResidentPage() {
        const view = document.getElementById('resident-view');
        if (!view) return;
        const slug = normalize(new URLSearchParams(location.search).get('r') || '').replace(/ /g, '');
        await loadResidents();
        if (document.getElementById('resident-view') !== view) return;
        const r = residents.find((x) => x.slug === slug);
        const nameEl = document.getElementById('resident-name');

        if (!r) {
            nameEl.textContent = 'resident not found';
            document.title = 'Residents - Radio Brodo';
            const p = document.createElement('p');
            p.className = 'page-intro';
            p.append("We couldn't find that resident. ");
            const back = document.createElement('a');
            back.href = '/residents'; back.textContent = 'See all residents';
            p.appendChild(back);
            view.replaceChildren(p);
            initLinks(view);
            return;
        }

        nameEl.textContent = r.name;
        document.title = `${r.name} - Radio Brodo`;
        const photo = document.getElementById('resident-photo');
        photo.src = r.photo;
        photo.hidden = false;

        const info = document.getElementById('resident-info');
        info.textContent = '';
        const add = (cls, text) => {
            if (!text) return null;
            const el = document.createElement('p');
            el.className = cls; el.textContent = text;
            info.appendChild(el); return el;
        };
        add('resident-city', r.city);
        const genresEl = document.createElement('div');
        genresEl.className = 'resident-genres';
        genresEl.hidden = true;
        info.appendChild(genresEl);
        add('resident-bio', r.bio);
        // "next on the menu" card, filled in from the schedule below
        const nextEl = document.createElement('div');
        nextEl.className = 'resident-next';
        nextEl.hidden = true;
        info.appendChild(nextEl);
        const showsLabel = document.getElementById('resident-shows-label');
        if (showsLabel) showsLabel.textContent = `from ${r.name}'s pot`;
        if (r.instagram || r.mixcloud) {
            const ul = document.createElement('ul');
            ul.className = 'resident-links';
            [['Instagram', r.instagram], ['Mixcloud', r.mixcloud]].forEach(([label, url]) => {
                if (!url) return;
                const li = document.createElement('li');
                const a = document.createElement('a');
                a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label;
                li.appendChild(a); ul.appendChild(li);
            });
            info.appendChild(ul);
        }

        // Next time on air, from the schedule sheet
        loadGlobalSchedule().then(() => {
            if (!nextEl.isConnected) return;
            const next = getUpcomingShows(200, 120).find((o) => hostsOf(`${o.show.DJ || ''} ${o.show.Show || ''}`).includes(r));
            nextEl.textContent = '';
            nextEl.hidden = !next;
            if (!next) return;
            const label = document.createElement('span');
            label.className = 'resident-next-label';
            label.textContent = next.live ? 'on air now' : 'next on the menu';
            const what = document.createElement('span');
            what.className = 'resident-next-when';
            what.textContent = next.show.Show || next.show.DJ || '';
            const when = document.createElement('span');
            when.className = 'resident-next-label';
            when.textContent = next.live ? `until ${timeOf(next.end)}` : formatWhen(next.start);
            nextEl.append(label, what, when);
        });

        // Their transmissions, from Mixcloud
        const list = document.getElementById('resident-shows');
        const count = document.getElementById('resident-count');
        showMessage(list, 'loading shows…');
        try {
            await loadArchive();
        } catch (error) {
            console.error("Couldn't fetch shows from Mixcloud:", error);
            if (list.isConnected) showMessage(list, "Couldn't load shows. Listen back on our Mixcloud page instead.");
            return;
        }
        if (!list.isConnected) return;
        const theirs = archive.filter((show) => hostsOf(show.name).includes(r));
        count.textContent = theirs.length ? String(theirs.length) : '';
        list.textContent = '';
        if (!theirs.length) showMessage(list, 'No archived shows yet.');
        theirs.forEach((show) => list.appendChild(buildShowCard(show)));

        // Genres: the Mixcloud tags they use most
        const tally = new Map();
        theirs.forEach((show) => (show.tags || []).forEach((t) => {
            const name = String(t.name || '').toLowerCase().trim();
            if (name) tally.set(name, (tally.get(name) || 0) + 1);
        }));
        const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
        genresEl.textContent = '';
        top.forEach((name) => {
            const chip = document.createElement('span');
            chip.textContent = name;
            genresEl.appendChild(chip);
        });
        genresEl.hidden = !top.length;
    }

    // ---- the show player: Mixcloud's classic widget, docked at the bottom ----
    // Lives outside #app-frame, so a show keeps playing while you browse.
    // Starting a show pauses the live stream, and starting the stream pauses the show.


    function loadWidgetApi() {
        if (window.Mixcloud) return Promise.resolve(window.Mixcloud);
        if (widgetApiPromise) return widgetApiPromise;
        widgetApiPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://widget.mixcloud.com/media/js/widgetApi.js';
            s.async = true;
            s.onload = () => (window.Mixcloud ? resolve(window.Mixcloud) : reject(new Error('no widget API')));
            s.onerror = () => reject(new Error('widget API failed to load'));
            document.head.appendChild(s);
        });
        widgetApiPromise.catch(() => { widgetApiPromise = null; });
        return widgetApiPromise;
    }

    function playArchived(show) {
        const dock = document.getElementById('mc-dock');
        const frame = document.getElementById('mc-frame');
        if (!dock || !frame || !show.key) { if (show.url) window.open(show.url, '_blank', 'noopener'); return; }

        pauseLive();
        frame.src = 'https://player-widget.mixcloud.com/widget/iframe/?light=1&hide_cover=1&autoplay=1&feed='
            + encodeURIComponent(show.key);
        markPlaying(show.key);
        const label = document.getElementById('mc-dock-label');
        if (label) label.textContent = show.name || '';
        dock.hidden = false;
        document.documentElement.setAttribute('data-dock', '');

        widget = null;
        loadWidgetApi().then((Mixcloud) => {
            const w = Mixcloud.PlayerWidget(frame);
            return w.ready.then(() => {
                widget = w;
                w.events.play.on(pauseLive);
            });
        }).catch(() => { /* the player still works, it just won't pause the stream by itself */ });
    }

    function closeDock() {
        const dock = document.getElementById('mc-dock');
        const frame = document.getElementById('mc-frame');
        if (frame) frame.src = 'about:blank';
        if (dock) dock.hidden = true;
        widget = null;
        document.documentElement.removeAttribute('data-dock');
        markPlaying(null);
    }

    // Ring the card of the show in the dock, wherever it appears on the page
    function markPlaying(key) {
        dockKey = key;
        document.querySelectorAll('.show-item').forEach((card) => {
            card.classList.toggle('is-playing', !!key && card.dataset.key === key);
        });
    }

    function pauseArchived() {
        if (widget) { try { widget.pause(); } catch (e) { /* ignore */ } }
    }

    function pauseLive() {
        const audioStream = document.getElementById('radio-stream');
        if (!audioStream || audioStream.paused) return;
        audioStream.pause();
        audioStream.removeAttribute('src');
        audioStream.load();
        syncPlayButton();
    }

    function initDock() {
        const close = document.getElementById('mc-dock-close');
        if (close) close.addEventListener('click', closeDock);
    }

    function initLinks(root) {
        if (!root) return;
        root.querySelectorAll('a[href^="/"]').forEach((link) => {
            link.addEventListener("click", (e) => {
                // Let the browser handle new-tab / new-window clicks and downloads
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                if (link.target && link.target !== '_self') return;
                e.preventDefault();
                if (link.href === window.location.href) return; // already here
                history.pushState(null, "", link.href);
                loadPage();
            });
        });
    }

    // ==========================================
    // 8. LIVE CHAT (WebSocket)
    // ==========================================
    // The drawer lives outside #app-frame, so it survives SPA page-swaps. This runs
    // once (guarded by chatInitialized, declared with the top-level state) and keeps a
    // single WebSocket alive across navigation.

    function initChat() {
        if (chatInitialized) return; // don't re-bind / reconnect on every page nav
        const drawer = document.getElementById('chat-drawer');
        const toggle = document.getElementById('chat-toggle');
        if (!drawer || !toggle) return;
        chatInitialized = true;

        const NICK_KEY = 'radiomantis-chat-nick';
        const log = document.getElementById('chat-log');
        const status = document.getElementById('chat-status');
        const msgForm = document.getElementById('chat-form');
        const msgInput = document.getElementById('chat-input');
        const nickForm = document.getElementById('chat-nick-form');
        const nickInput = document.getElementById('chat-nick-input');
        const closeBtn = document.getElementById('chat-close');

        // Moderator access: visit the site with ?admin=<token> once; it's kept in
        // sessionStorage so it survives SPA navigation (which drops the query string).
        const ADMIN_KEY = 'radiomantis-chat-admin';
        const urlAdmin = new URLSearchParams(location.search).get('admin');
        if (urlAdmin) sessionStorage.setItem(ADMIN_KEY, urlAdmin);
        const adminToken = sessionStorage.getItem(ADMIN_KEY);

        const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
        const base = isLocal
            ? `ws://${location.hostname}:8081/chat`
            : `wss://${location.host}/chat`;
        const CHAT_URL = adminToken ? `${base}?token=${encodeURIComponent(adminToken)}` : base;

        let ws = null;
        let nick = localStorage.getItem(NICK_KEY) || '';
        let reconnectDelay = 1000;

        // ---- rendering (always textContent — never innerHTML — so messages can't inject) ----
        function atBottom() {
            return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        }
        function trimLog() {
            while (log.childNodes.length > 200) log.removeChild(log.firstChild);
        }
        function addMessage(nickName, text, ts) {
            const stick = atBottom();
            const row = document.createElement('div');
            row.className = 'chat-msg';
            const time = document.createElement('span');
            time.className = 'chat-msg-time';
            if (ts) {
                const d = new Date(ts);
                // Viewer's local timezone, 24h, Latin digits — ts is absolute.
                time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, numberingSystem: 'latn' });
                time.title = d.toLocaleString();
            }
            const who = document.createElement('span');
            who.className = 'chat-msg-nick';
            if (nickName === nick) who.classList.add('chat-msg-nick--me'); 
            who.textContent = nickName + ":";
            const body = document.createElement('span');
            body.className = 'chat-msg-text';
            body.textContent = text;
            row.append(time, who, body);
            log.appendChild(row);
            trimLog();
            if (stick) log.scrollTop = log.scrollHeight;
        }
        function addSystem(text) {
            const stick = atBottom();
            const row = document.createElement('div');
            row.className = 'chat-msg chat-msg--system';
            row.textContent = text;
            log.appendChild(row);
            trimLog();
            if (stick) log.scrollTop = log.scrollHeight;
        }

        // ---- nickname gate ----
        function applyNickState() {
            drawer.classList.toggle('needs-nick', !nick);
            document.getElementById('chat-title').textContent = nick ? `chat as ${nick}` : 'chat';
        }
        function setNick(value) {
            const v = value.trim().slice(0, 24);
            if (!v) return false;
            nick = v;
            localStorage.setItem(NICK_KEY, nick);
            applyNickState();
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'join', nick }));
            return true;
        }
        function logout() {
            nick = '';
            localStorage.removeItem(NICK_KEY);
            applyNickState(); // reopens the "pick a name" gate
            if (nickInput) nickInput.focus();
        }

        // ---- connection ----
        function connect() {
            status.textContent = 'connecting…';
            try {
                ws = new WebSocket(CHAT_URL);
            } catch (err) {
                scheduleReconnect();
                return;
            }
            ws.addEventListener('open', () => {
                reconnectDelay = 1000;
                status.textContent = '';
                status.classList.add('is-hidden');
                if (nick) ws.send(JSON.stringify({ type: 'join', nick }));
            });
            ws.addEventListener('message', (e) => {
                let data;
                try { data = JSON.parse(e.data); } catch { return; }
                if (data.type === 'history' && Array.isArray(data.messages)) {
                    log.textContent = '';
                    data.messages.forEach((m) => addMessage(m.nick, m.text, m.ts));
                    log.scrollTop = log.scrollHeight;
                } else if (data.type === 'msg') {
                    addMessage(data.nick, data.text, data.ts);
                } else if (data.type === 'system') {
                    addSystem(data.text);
                } else if (data.type === 'clear') {
                    log.textContent = '';
                }
            });
            ws.addEventListener('close', scheduleReconnect);
            ws.addEventListener('error', () => { try { ws.close(); } catch (e) {} });
        }
        function scheduleReconnect() {
            status.classList.remove('is-hidden');
            status.textContent = 'reconnecting…';
            setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 15000);
        }

        // ---- mobile keyboard: keep the drawer sized to the visible viewport so the
        // input sits just above the on-screen keyboard (a fixed 100dvh element would
        // otherwise be overlapped, hiding the input and showing the page behind it) ----
        function fitViewport() {
            const vv = window.visualViewport;
            if (!vv) return;
            if (drawer.classList.contains('open')) {
                drawer.style.height = vv.height + 'px';
                drawer.style.top = vv.offsetTop + 'px';
                log.scrollTop = log.scrollHeight;
            } else {
                drawer.style.height = '';
                drawer.style.top = '';
            }
        }
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', fitViewport);
            window.visualViewport.addEventListener('scroll', fitViewport);
        }

        // ---- events ----
        // `inert` keeps keyboard focus out of the drawer while it's slid off-screen
        function setDrawerOpen(open) {
            drawer.classList.toggle('open', open);
            drawer.setAttribute('aria-hidden', String(!open));
            drawer.inert = !open;
            toggle.setAttribute('aria-expanded', String(open));
            fitViewport();
            if (open) (nick ? msgInput : nickInput).focus();
        }
        drawer.inert = !drawer.classList.contains('open');

        toggle.addEventListener('click', () => {
            setDrawerOpen(!drawer.classList.contains('open'));
        });
        closeBtn.addEventListener('click', () => {
            setDrawerOpen(false);
            toggle.focus();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && drawer.classList.contains('open')) {
                setDrawerOpen(false);
                toggle.focus();
            }
        });
        nickForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (setNick(nickInput.value)) msgInput.focus();
        });
        msgForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = msgInput.value.trim();
            if (!text) return;
            msgInput.value = '';

            // Self-service commands, handled locally (never sent as chat)
            if (text === '/logout') { logout(); return; }
            const rename = text.match(/^\/nick\s+(.+)$/i);
            if (rename) {
                if (setNick(rename[1])) addSystem(`you're now ${nick}`);
                return;
            }

            if (!nick) return;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'msg', text }));
            }
        });

        // Discoverability hint for the self-service commands (injected so the drawer
        // markup stays identical across pages)
        const nickGate = document.getElementById('chat-nick-gate');
        if (nickGate && !nickGate.querySelector('.chat-hint')) {
            const hint = document.createElement('p');
            hint.className = 'chat-hint';
            hint.textContent = 'change it later with /nick <name>, or /logout to reset';
            nickGate.appendChild(hint);
        }

        applyNickState();
        connect();
    }
});
