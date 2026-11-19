/**
 * Z-Legends 3: Z-Hub In-Game Overlay
 * Includes:
 * 1. Mini Game: Vòng Quay Ngọc Rồng (Shenron's Lucky Wheel)
 * 2. Save Backup & Restore System (Option 2: Mã Sao Lưu An Toàn)
 * 3. Giftcode Redemption System
 *
 * NOTE: Button is positioned at the BOTTOM-RIGHT corner and ONLY appears
 * on the Main Menu ("Menu Inicial"). When navigating to any other layout/screen,
 * it disappears completely.
 */

(function () {
    "use strict";

    // 45 unlockable characters with authentic Vietnamese display names
    var ALL_CHARACTERS = [
        { key: "GokuSsj_Desbloqueado", name: "Goku Super Saiyan" },
        { key: "GokuBlue_Desbloqueado", name: "Goku Super Saiyan Blue" },
        { key: "GokuUI_Desbloqueado", name: "Goku Bản Năng Vô Cực (UI)" },
        { key: "GokuUIPressagio_Desbloqueado", name: "Goku Điềm Báo Vô Cực (UI Sign)" },
        { key: "GokuSaiyanSaga_Desbloqueado", name: "Goku (Saiyan Saga / Kaioken)" },
        { key: "GokuBlackRose_Desbloqueado", name: "Goku Black Rosé" },
        { key: "VegetaBase_Desbloqueado", name: "Vegeta (Base)" },
        { key: "VegetaSsj_Desbloqueado", name: "Vegeta Super Saiyan" },
        { key: "VegetaEgo_Desbloqueado", name: "Vegeta Bản Ngã Tối Thượng (Ultra Ego)" },
        { key: "VegetaSaiyanSaga_Desbloqueado", name: "Vegeta (Scouter Saiyan Saga)" },
        { key: "Bardock_Desbloqueado", name: "Bardock (Base)" },
        { key: "BardockSsj_Desbloqueado", name: "Bardock Super Saiyan" },
        { key: "GohanMistico_Desbloqueado", name: "Ultimate Gohan" },
        { key: "GohanBeast_Desbloqueado", name: "Gohan Beast" },
        { key: "GohanSsj2_Desbloqueado", name: "Gohan Super Saiyan 2" },
        { key: "MiraiGohan_Desbloqueado", name: "Future Gohan (Gohan Tương Lai)" },
        { key: "GogetaSsjBlue_Desbloqueado", name: "Gogeta Super Saiyan Blue" },
        { key: "VegettoSsjBlue_Desbloqueado", name: "Vegito Super Saiyan Blue" },
        { key: "GogetaSsj4_Desbloqueado", name: "Gogeta Super Saiyan 4" },
        { key: "SuperBaby_Desbloqueado", name: "Super Baby 2" },
        { key: "Moro73_Desbloqueado", name: "Moro 73" },
        { key: "Piccolo_Desbloqueado", name: "Piccolo" },
        { key: "Jiren_Desbloqueado", name: "Jiren" },
        { key: "Nappa_Desbloqueado", name: "Nappa" },
        { key: "Hitto_Desbloqueado", name: "Hit (Sát thủ Hitto)" },
        { key: "Android18_Desbloqueado", name: "Số 18 (Android 18)" },
        { key: "Android17_Desbloqueado", name: "Số 17 (Android 17)" },
        { key: "Android21_Desbloqueado", name: "Số 21 (Android 21)" },
        { key: "Janemba_Desbloqueado", name: "Super Janemba" },
        { key: "Cell_Desbloqueado", name: "Perfect Cell" },
        { key: "BrolyIkari_Desbloqueado", name: "Broly Phẫn Nộ (Ikari)" },
        { key: "BrolyZ_Desbloqueado", name: "Broly Huyền Thoại (DBZ)" },
        { key: "Raditz_Desbloqueado", name: "Raditz" },
        { key: "ZamasuFusion_Desbloqueado", name: "Hợp Thể Zamasu" },
        { key: "Bills_Desbloqueado", name: "Thần Hủy Diệt Beerus" },
        { key: "Tienshinhan_Desbloqueado", name: "Tien Shinhan" },
        { key: "KidBuu_Desbloqueado", name: "Kid Buu" },
        { key: "MajinBuu_Desbloqueado", name: "Majin Buu (Béo)" },
        { key: "Kefla_Desbloqueado", name: "Kefla Super Saiyan" },
        { key: "Freeza_Desbloqueado", name: "Frieza Hoàng Kim" },
        { key: "Cooler_Desbloqueado", name: "Cooler Final Form" },
        { key: "Ginyu_Desbloqueado", name: "Đội Trưởng Ginyu" },
        { key: "Krillin_Desbloqueado", name: "Krillin" },
        { key: "SuperTrunks_Desbloqueado", name: "Super Trunks" },
        { key: "MiraiTrunks_Desbloqueado", name: "Trunks Tương Lai" }
    ];

    // Visibility Controller (Menu-Only, Bottom-Right)
    function updateTriggerButtonVisibility(layoutName) {
        var btn = document.getElementById("z3-trigger-btn");
        if (!btn) return;
        if (!layoutName) {
            var rt = getC2Runtime();
            if (rt && rt.running_layout) layoutName = rt.running_layout.name;
        }
        var isMainMenu = (layoutName === "Menu Inicial");
        var isModalOpen = document.getElementById("z3-modal-overlay") && document.getElementById("z3-modal-overlay").classList.contains("active");

        if (isMainMenu && !isModalOpen) {
            btn.style.display = "flex";
        } else {
            btn.style.display = "none";
        }
    }
    window.__z3OnLayoutChange = updateTriggerButtonVisibility;
    window.__z3CheckMenuVisibility = updateTriggerButtonVisibility;

    // Fast layout check loop
    setInterval(function () {
        updateTriggerButtonVisibility();
    }, 60);

    // Instant hide on menu touch
    function handleOutsideTouch(e) {
        var t = e.target;
        if (t && t.nodeType !== 1 && t.parentElement) t = t.parentElement;
        if (t && (t.id === "z3-trigger-btn" || t.id === "z3-modal-overlay" || (t.closest && (t.closest("#z3-trigger-btn") || t.closest("#z3-modal-overlay"))))) {
            return;
        }
        requestAnimationFrame(function () {
            updateTriggerButtonVisibility();
        });
        setTimeout(updateTriggerButtonVisibility, 60);
        setTimeout(updateTriggerButtonVisibility, 180);
    }
    document.addEventListener("pointerdown", handleOutsideTouch, { capture: true, passive: true });
    document.addEventListener("touchstart", handleOutsideTouch, { capture: true, passive: true });

    // Web Audio Synthesizer (Zero asset dependencies)
    var audioCtx = null;
    function getAudioCtx() {
        if (!audioCtx) {
            var AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) audioCtx = new AudioContextClass();
        }
        if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume().catch(function () {});
        }
        return audioCtx;
    }

    function playTickSound() {
        try {
            var ctx = getAudioCtx();
            if (!ctx) return;
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.type = "triangle";
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.03);
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.03);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.035);
        } catch (e) {}
    }

    function playFanfareSound(jackpot) {
        try {
            var ctx = getAudioCtx();
            if (!ctx) return;
            var freqs = jackpot ? [523.25, 659.25, 783.99, 1046.50, 1318.51] : [440, 554.37, 659.25, 880];
            var now = ctx.currentTime;
            freqs.forEach(function (f, idx) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = jackpot ? "square" : "triangle";
                osc.frequency.setValueAtTime(f, now + idx * 0.08);
                gain.gain.setValueAtTime(0.18, now + idx * 0.08);
                gain.gain.exponentialRampToValueAtTime(0.01, now + idx * 0.08 + 0.35);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now + idx * 0.08);
                osc.stop(now + idx * 0.08 + 0.38);
            });
        } catch (e) {}
    }

    // Construct 2 Bridge
    function getC2Runtime() {
        return (typeof window["cr_getC2Runtime"] === "function") ? window["cr_getC2Runtime"]() : null;
    }

    function getGlobalVar(name) {
        var rt = getC2Runtime();
        if (rt && rt.all_global_vars) {
            for (var i = 0; i < rt.all_global_vars.length; i++) {
                if (rt.all_global_vars[i].name === name) {
                    return rt.all_global_vars[i].data;
                }
            }
        }
        return null;
    }

    function setGlobalVar(name, val) {
        var rt = getC2Runtime();
        if (rt && rt.all_global_vars) {
            for (var i = 0; i < rt.all_global_vars.length; i++) {
                if (rt.all_global_vars[i].name === name) {
                    rt.all_global_vars[i].data = val;
                    return true;
                }
            }
        }
        return false;
    }

    // Persistent Storage Read / Write
    function storageGet(key) {
        return new Promise(function (resolve) {
            if (window["__c2LocalForage"] && window["__c2LocalForage"].getItem) {
                window["__c2LocalForage"].getItem(key, function (err, val) {
                    if (!err && val !== null && val !== undefined) {
                        return resolve(val);
                    }
                    fallback();
                });
            } else {
                fallback();
            }
            function fallback() {
                try {
                    var v = localStorage.getItem(key);
                    if (v !== null) {
                        try { return resolve(JSON.parse(v)); } catch (e) { return resolve(v); }
                    }
                } catch (e) {}
                resolve(null);
            }
        });
    }

    function storageSet(key, val) {
        return new Promise(function (resolve) {
            setGlobalVar(key, val);
            try {
                localStorage.setItem(key, typeof val === "object" ? JSON.stringify(val) : String(val));
            } catch (e) {}
            if (window["__c2LocalForage"] && window["__c2LocalForage"].setItem) {
                window["__c2LocalForage"].setItem(key, val, function () {
                    resolve(true);
                });
            } else {
                resolve(true);
            }
        });
    }

    // Currencies API
    async function getLiveCoins() {
        var g = getGlobalVar("QUANTIDADE_DE_MOEDAS");
        if (g !== null && !isNaN(Number(g))) return Number(g);
        var s = await storageGet("QUANTIDADE_DE_MOEDAS");
        if (s !== null && !isNaN(Number(s))) return Number(s);
        return 0;
    }

    async function getLiveBP() {
        var g = getGlobalVar("MEUS_PONTOS");
        if (g !== null && !isNaN(Number(g))) return Number(g);
        var s = await storageGet("MEUS_PONTOS");
        if (s !== null && !isNaN(Number(s))) return Number(s);
        return 0;
    }

    async function addCoins(amount) {
        var cur = await getLiveCoins();
        var next = Math.max(0, cur + amount);
        await storageSet("QUANTIDADE_DE_MOEDAS", next);
        await storageSet("SALVAMENTO_SEC_DE_MOEDAS", next);
        updateHeaderBalances();
        return next;
    }

    async function addBP(amount) {
        var cur = await getLiveBP();
        var next = Math.max(0, cur + amount);
        await storageSet("MEUS_PONTOS", next);
        updateHeaderBalances();
        return next;
    }

    async function unlockRandomChar() {
        var locked = [];
        for (var i = 0; i < ALL_CHARACTERS.length; i++) {
            var c = ALL_CHARACTERS[i];
            var g = getGlobalVar(c.key);
            var s = await storageGet(c.key);
            if (Number(g) !== 1 && Number(s) !== 1) {
                locked.push(c);
            }
        }
        if (locked.length === 0) {
            return { allUnlocked: true };
        }
        var chosen = locked[Math.floor(Math.random() * locked.length)];
        await storageSet(chosen.key, 1);
        return { allUnlocked: false, char: chosen, remaining: locked.length - 1 };
    }

    async function countUnlockedCharacters() {
        var count = 0;
        for (var i = 0; i < ALL_CHARACTERS.length; i++) {
            var c = ALL_CHARACTERS[i];
            var g = getGlobalVar(c.key);
            var s = await storageGet(c.key);
            if (Number(g) === 1 || Number(s) === 1) count++;
        }
        return count;
    }

    // Daily Spins
    function getTodayString() {
        var d = new Date();
        return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
    }

    async function getSpinsRemaining() {
        var today = getTodayString();
        var lastDate = await storageGet("Z3_WHEEL_DATE");
        if (lastDate !== today) {
            await storageSet("Z3_WHEEL_DATE", today);
            await storageSet("Z3_WHEEL_FREE_SPINS", 3);
            return 3;
        }
        var rem = await storageGet("Z3_WHEEL_FREE_SPINS");
        return (rem !== null && !isNaN(Number(rem))) ? Number(rem) : 0;
    }

    async function deductFreeSpin() {
        var rem = await getSpinsRemaining();
        if (rem > 0) {
            await storageSet("Z3_WHEEL_FREE_SPINS", rem - 1);
            return rem - 1;
        }
        return 0;
    }

    // Lucky Wheel Slices (8 segments)
    var WHEEL_SLICES = [
        { label: "500 Xu", type: "coins", val: 500, bg: "#e65100", text: "#fff" },
        { label: "1,000 Xu", type: "coins", val: 1000, bg: "#1a237e", text: "#ffd700" },
        { label: "100 BP", type: "bp", val: 100, bg: "#006064", text: "#00f5d4" },
        { label: "2,000 Xu", type: "coins", val: 2000, bg: "#b71c1c", text: "#fff" },
        { label: "5,000 Xu", type: "coins", val: 5000, bg: "#f57f17", text: "#12131c" },
        { label: "300 BP", type: "bp", val: 300, bg: "#1b5e20", text: "#76ff03" },
        { label: "10,000 Xu", type: "coins", val: 10000, bg: "#4a148c", text: "#ffbe0b" },
        { label: "🐉 RƯƠNG RỒNG", type: "jackpot", val: 20000, bg: "#880e4f", text: "#fff" }
    ];

    var currentRotation = 0;
    var isSpinning = false;

    function renderWheel(ctx, size, angle) {
        var r = size / 2;
        ctx.clearRect(0, 0, size, size);
        ctx.save();
        ctx.translate(r, r);
        ctx.rotate(angle);

        var numSlices = WHEEL_SLICES.length;
        var sliceAngle = (2 * Math.PI) / numSlices;

        for (var i = 0; i < numSlices; i++) {
            var item = WHEEL_SLICES[i];
            var start = i * sliceAngle;
            var end = start + sliceAngle;

            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, r - 4, start, end);
            ctx.fillStyle = item.bg;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#ffbe0b";
            ctx.stroke();

            // Label
            ctx.save();
            ctx.rotate(start + sliceAngle / 2);
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillStyle = item.text;
            ctx.font = (item.type === "jackpot" ? "bold 13px" : "bold 14px") + " -apple-system, sans-serif";
            ctx.shadowColor = "rgba(0,0,0,0.8)";
            ctx.shadowBlur = 4;
            ctx.fillText(item.label, r - 22, 0);
            ctx.restore();
        }

        // Outer Ring
        ctx.beginPath();
        ctx.arc(0, 0, r - 3, 0, 2 * Math.PI);
        ctx.lineWidth = 6;
        ctx.strokeStyle = "#ffbe0b";
        ctx.stroke();

        ctx.restore();
    }

    // UI Toast Notification
    function showToast(msg) {
        var toast = document.getElementById("z3-toast");
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add("show");
        clearTimeout(toast.__timer);
        toast.__timer = setTimeout(function () {
            toast.classList.remove("show");
        }, 2600);
    }

    // Update Header Badges
    async function updateHeaderBalances() {
        var coinsEl = document.getElementById("z3-badge-coins");
        var bpEl = document.getElementById("z3-badge-bp");
        var charsEl = document.getElementById("z3-badge-chars");
        if (coinsEl) coinsEl.textContent = (await getLiveCoins()).toLocaleString("vi-VN");
        if (bpEl) bpEl.textContent = (await getLiveBP()).toLocaleString("vi-VN");
        if (charsEl) charsEl.textContent = (await countUnlockedCharacters()) + " / " + ALL_CHARACTERS.length;
    }

    // Spin Animation
    async function startSpin() {
        if (isSpinning) return;
        var freeRem = await getSpinsRemaining();
        var bp = await getLiveBP();

        var useBP = false;
        if (freeRem > 0) {
            await deductFreeSpin();
        } else if (bp >= 200) {
            await addBP(-200);
            useBP = true;
        } else {
            showToast("Bạn đã hết lượt quay miễn phí và không đủ 200 BP!");
            return;
        }

        isSpinning = true;
        var spinBtn = document.getElementById("z3-spin-main-btn");
        if (spinBtn) spinBtn.disabled = true;

        var canvas = document.getElementById("z3-wheel-canvas");
        var ctx = canvas.getContext("2d");
        var size = canvas.width;

        // Choose random target
        var weights = [25, 20, 18, 15, 10, 8, 3, 1]; // sum = 100
        var randVal = Math.random() * 100;
        var sum = 0;
        var chosenIndex = 0;
        for (var w = 0; w < weights.length; w++) {
            sum += weights[w];
            if (randVal <= sum) {
                chosenIndex = w;
                break;
            }
        }

        var sliceCount = WHEEL_SLICES.length;
        var sliceAngle = (2 * Math.PI) / sliceCount;

        var targetOffset = (3 * Math.PI / 2) - (chosenIndex + 0.5) * sliceAngle;
        var extraSpins = (5 + Math.floor(Math.random() * 4)) * (2 * Math.PI);
        var finalAngle = currentRotation + extraSpins + (targetOffset - (currentRotation % (2 * Math.PI)));
        while (finalAngle < currentRotation + 4 * (2 * Math.PI)) {
            finalAngle += 2 * Math.PI;
        }

        var startAngle = currentRotation;
        var deltaAngle = finalAngle - startAngle;
        var startTime = performance.now();
        var duration = 4600; // ms

        var lastTickIndex = -1;

        function animate(now) {
            var elapsed = now - startTime;
            var progress = Math.min(1, elapsed / duration);
            var ease = 1 - Math.pow(1 - progress, 3);
            var currentAngle = startAngle + deltaAngle * ease;

            renderWheel(ctx, size, currentAngle);

            var currentSlice = Math.floor((((3 * Math.PI / 2 - currentAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / sliceAngle);
            if (currentSlice !== lastTickIndex) {
                lastTickIndex = currentSlice;
                playTickSound();
            }

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                currentRotation = finalAngle % (2 * Math.PI);
                onSpinFinished(WHEEL_SLICES[chosenIndex]);
            }
        }

        requestAnimationFrame(animate);
    }

    async function onSpinFinished(slice) {
        isSpinning = false;
        var spinBtn = document.getElementById("z3-spin-main-btn");
        if (spinBtn) spinBtn.disabled = false;

        var banner = document.getElementById("z3-prize-banner");
        var isJackpot = slice.type === "jackpot";

        playFanfareSound(isJackpot);

        if (slice.type === "coins") {
            await addCoins(slice.val);
            if (banner) banner.innerHTML = "🎉 Chúc mừng! Bạn nhận được <b>+" + slice.val.toLocaleString("vi-VN") + " Xu (Zeni)</b>!";
            showToast("+" + slice.val.toLocaleString("vi-VN") + " Xu!");
        } else if (slice.type === "bp") {
            await addBP(slice.val);
            if (banner) banner.innerHTML = "⚡ Tuyệt vời! Bạn nhận được <b>+" + slice.val + " Điểm Chiến Đấu (BP)</b>!";
            showToast("+" + slice.val + " Điểm BP!");
        } else if (slice.type === "jackpot") {
            await addCoins(slice.val);
            var unlockResult = await unlockRandomChar();
            if (unlockResult.allUnlocked) {
                await addCoins(50000);
                if (banner) banner.innerHTML = "🌟 RỒNG THẦN XUẤT HIỆN! Bạn đã sở hữu tất cả 45 tướng! Thưởng thêm <b>+70,000 Xu Độc Đắc</b>!";
                showToast("🌟 RỒNG THẦN: +70,000 Xu!");
            } else {
                if (banner) banner.innerHTML = "🐉 RỒNG THẦN BAN PHƯỚC! Nhận <b>+" + slice.val.toLocaleString("vi-VN") + " Xu</b> và MỞ KHÓA TƯỚNG: <br><b style='color:#ffd700;font-size:15px;'>" + unlockResult.char.name + "</b>!";
                showToast("🎉 Mở khóa thành công: " + unlockResult.char.name + "!");
            }
        }

        updateWheelUI();
    }

    async function updateWheelUI() {
        await updateHeaderBalances();
        var rem = await getSpinsRemaining();
        var countEl = document.getElementById("z3-spin-rem-text");
        var spinBtn = document.getElementById("z3-spin-main-btn");
        if (countEl) {
            countEl.textContent = rem > 0 ? (rem + " / 3 lượt miễn phí hôm nay") : "Hết lượt miễn phí hôm nay";
        }
        if (spinBtn) {
            if (rem > 0) {
                spinBtn.innerHTML = "🎯 QUAY NGAY <span style='font-size:12px;'>(Miễn phí: " + rem + "/3)</span>";
            } else {
                spinBtn.innerHTML = "🎯 QUAY VÒNG <span style='font-size:12px;'>(Phí: 200 BP)</span>";
            }
        }
    }

    // Export Save Code
    async function exportSaveData() {
        var keysToCollect = [
            "QUANTIDADE_DE_MOEDAS",
            "SALVAMENTO_SEC_DE_MOEDAS",
            "MEUS_PONTOS",
            "Opacidade_Dos_Botoes",
            "MUSICA_SELECIONADA",
            "Volume_Das_Musicas",
            "Volume_Das_Explosoes",
            "Volume_Dos_Efeitos_Sonoros",
            "Vozes_Dos_Personagens",
            "Voz_Do_Narrador",
            "Idioma_Selecionado",
            "Pular_Introducoes",
            "Desativar_Legendas",
            "MostrarEOcultarHud",
            "DefesaDoInimigo_Treino",
            "EnergiaSempreCheio_Treino",
            "MostarControlesUsados_Treino",
            "AtivarEDestivar_HitStop",
            "Z3_CLAIMED_CODES"
        ];

        ALL_CHARACTERS.forEach(function (c) {
            keysToCollect.push(c.key);
        });

        var hudKeys = [
            "HUD_Botão_GAMEPAD_Posição_X", "HUD_Botão_GAMEPAD_Posição_Y",
            "HUD_Botão_TRAS_Posição_X", "HUD_Botão_TRAS_Posição_Y",
            "HUD_Botão_FRENTE_Posição_X", "HUD_Botão_FRENTE_Posição_Y",
            "HUD_Botão_CIMA_Posição_X", "HUD_Botão_CIMA_Posição_Y",
            "HUD_Botão_BAIXO_Posição_X", "HUD_Botão_BAIXO_Posição_Y",
            "HUD_Botão_DIAGONALTRAS_Posição_X", "HUD_Botão_DIAGONALTRAS_Posição_Y",
            "HUD_Botão_DIAGONALFRENTE_Posição_X", "HUD_Botão_DIAGONALFRENTE_Posição_Y",
            "HUD_Botão_CARREGARKI_Posição_X", "HUD_Botão_CARREGARKI_Posição_Y",
            "HUD_Botão_DASH_Posição_X", "HUD_Botão_DASH_Posição_Y",
            "HUD_Botão_DEFESA_Posição_X", "HUD_Botão_DEFESA_Posição_Y",
            "HUD_Botão_ATAQUELEVE_Posição_X", "HUD_Botão_ATAQUELEVE_Posição_Y",
            "HUD_Botão_ATAQUEMEDIO_Posição_X", "HUD_Botão_ATAQUEMEDIO_Posição_Y",
            "HUD_Botão_ATAQUEPESADO_Posição_X", "HUD_Botão_ATAQUEPESADO_Posição_Y",
            "HUD_Botão_ATAQUEESPECIAL_Posição_X", "HUD_Botão_ATAQUEESPECIAL_Posição_Y",
            "HUD_Botão_ATAQUEULTIMATE_Posição_X", "HUD_Botão_ATAQUEULTIMATE_Posição_Y",
            "HUD_Botão_ZASSIST1_Posição_X", "HUD_Botão_ZASSIST1_Posição_Y",
            "HUD_Botão_TRANSFORMACAO_Posição_X", "HUD_Botão_TRANSFORMACAO_Posição_Y",
            "HUD_Botão_ZASSIST2_Posição_X", "HUD_Botão_ZASSIST2_Posição_Y",
            "HUD_Botão_DRAGONRUSH_Posição_X", "HUD_Botão_DRAGONRUSH_Posição_Y"
        ];
        keysToCollect = keysToCollect.concat(hudKeys);

        var dataObj = {};
        for (var i = 0; i < keysToCollect.length; i++) {
            var k = keysToCollect[i];
            var gVal = getGlobalVar(k);
            var sVal = await storageGet(k);
            var finalVal = (gVal !== null && gVal !== undefined) ? gVal : sVal;
            if (finalVal !== null && finalVal !== undefined) {
                dataObj[k] = finalVal;
            }
        }

        var pkg = {
            app: "Z3_LEGENDS",
            ver: 3,
            time: Date.now(),
            coins: await getLiveCoins(),
            bp: await getLiveBP(),
            data: dataObj
        };

        var jsonStr = JSON.stringify(pkg);
        var base64 = btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g, function (match, p1) {
            return String.fromCharCode("0x" + p1);
        }));

        var code = "Z3SAVE_" + base64;
        var textarea = document.getElementById("z3-export-textarea");
        if (textarea) {
            textarea.value = code;
            textarea.select();
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(function () {
                showToast("📋 Đã sao chép mã sao lưu vào bộ nhớ tạm!");
            }).catch(function () {
                showToast("Mã sao lưu đã được tạo! Bạn có thể chọn và sao chép.");
            });
        } else {
            showToast("Mã sao lưu đã được tạo! Bạn có thể chọn và sao chép.");
        }
    }

    // Import Save Code
    async function importSaveData() {
        var textarea = document.getElementById("z3-import-textarea");
        if (!textarea || !textarea.value.trim()) {
            showToast("Vui lòng dán mã sao lưu vào ô trước!");
            return;
        }

        var raw = textarea.value.trim();
        if (!raw.startsWith("Z3SAVE_")) {
            showToast("Lỗi: Mã sao lưu không đúng định dạng (phải bắt đầu bằng Z3SAVE_)!");
            return;
        }

        var base64 = raw.substring(7);
        var pkg = null;
        try {
            var jsonStr = decodeURIComponent(Array.prototype.map.call(atob(base64), function (c) {
                return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(""));
            pkg = JSON.parse(jsonStr);
        } catch (e) {
            showToast("Lỗi: Mã sao lưu bị hỏng hoặc không giải mã được!");
            return;
        }

        if (!pkg || pkg.app !== "Z3_LEGENDS" || !pkg.data) {
            showToast("Lỗi: Dữ liệu sao lưu không hợp lệ!");
            return;
        }

        var count = 0;
        var keys = Object.keys(pkg.data);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var v = pkg.data[k];
            await storageSet(k, v);
            count++;
        }

        await updateHeaderBalances();
        showToast("🎉 Khôi phục thành công " + count + " mục dữ liệu!");

        setTimeout(function () {
            if (confirm("Khôi phục thành công! Bạn có muốn khởi động lại màn hình để áp dụng toàn bộ giao diện?")) {
                window.location.reload();
            }
        }, 500);
    }

    // Giftcodes System
    var GIFTCODES = {
        "DRAGONBALL": { coins: 10000, bp: 0, desc: "+10,000 Xu" },
        "SUPERHERO": { coins: 15000, bp: 100, desc: "+15,000 Xu & +100 BP" },
        "ZLEGENDS3": { coins: 20000, bp: 300, desc: "+20,000 Xu & +300 BP" },
        "THANHUYDIET": { coins: 30000, bp: 500, desc: "+30,000 Xu & +500 BP" },
        "HOANGKIM": { coins: 50000, bp: 1000, desc: "+50,000 Xu & +1,000 BP (VIP)" }
    };

    async function redeemGiftcode() {
        var input = document.getElementById("z3-giftcode-input");
        if (!input || !input.value.trim()) {
            showToast("Vui lòng nhập mã quà tặng!");
            return;
        }

        var code = input.value.trim().toUpperCase();
        var reward = GIFTCODES[code];
        if (!reward) {
            showToast("Mã quà tặng không hợp lệ hoặc đã hết hạn!");
            return;
        }

        var claimedList = await storageGet("Z3_CLAIMED_CODES");
        if (!Array.isArray(claimedList)) claimedList = [];

        if (claimedList.indexOf(code) !== -1) {
            showToast("Bạn đã từng nhận mã này rồi!");
            return;
        }

        claimedList.push(code);
        await storageSet("Z3_CLAIMED_CODES", claimedList);

        if (reward.coins) await addCoins(reward.coins);
        if (reward.bp) await addBP(reward.bp);

        playFanfareSound(true);
        showToast("🎁 Chúc mừng! Nhận thành công " + reward.desc + "!");
        input.value = "";
    }

    // Modal Visibility & Tabs
    function openModal() {
        var modal = document.getElementById("z3-modal-overlay");
        if (modal) {
            modal.classList.add("active");
            if (window.cr_setSuspended) window.cr_setSuspended(true);
            updateHeaderBalances();
            updateWheelUI();
            updateTriggerButtonVisibility();

            var canvas = document.getElementById("z3-wheel-canvas");
            if (canvas) {
                var ctx = canvas.getContext("2d");
                renderWheel(ctx, canvas.width, currentRotation);
            }
        }
    }

    function closeModal() {
        var modal = document.getElementById("z3-modal-overlay");
        if (modal) {
            modal.classList.remove("active");
            if (window.cr_setSuspended) window.cr_setSuspended(false);
            updateTriggerButtonVisibility();
        }
    }

    function switchTab(tabIndex) {
        var tabs = document.querySelectorAll(".z3-tab-btn");
        var contents = document.querySelectorAll(".z3-tab-content");
        tabs.forEach(function (t, i) {
            t.classList.toggle("active", i === tabIndex);
        });
        contents.forEach(function (c, i) {
            c.classList.toggle("active", i === tabIndex);
        });
        if (tabIndex === 0) {
            var canvas = document.getElementById("z3-wheel-canvas");
            if (canvas) {
                var ctx = canvas.getContext("2d");
                renderWheel(ctx, canvas.width, currentRotation);
            }
        }
    }

    // Build DOM
    function injectUI() {
        if (document.getElementById("z3-trigger-btn")) return;

        // Trigger Button (Hidden by default, shown only in Menu Inicial)
        var btn = document.createElement("button");
        btn.id = "z3-trigger-btn";
        btn.innerHTML = "<span class=\"z3-star-icon\">★</span> 🐉 Z-HUB";
        document.body.appendChild(btn);

        // Toast
        var toast = document.createElement("div");
        toast.id = "z3-toast";
        document.body.appendChild(toast);

        // Modal Overlay
        var overlay = document.createElement("div");
        overlay.id = "z3-modal-overlay";
        overlay.innerHTML =
            "<div class=\"z3-modal-container\">" +
                "<div class=\"z3-modal-header\">" +
                    "<div class=\"z3-modal-title\"><span>🐉</span> Z-LEGENDS HUB</div>" +
                    "<div class=\"z3-currency-badges\">" +
                        "<div class=\"z3-badge coins\">💰 <span id=\"z3-badge-coins\">0</span> Xu</div>" +
                        "<div class=\"z3-badge bp\">⚡ <span id=\"z3-badge-bp\">0</span> BP</div>" +
                        "<div class=\"z3-badge\" style=\"border-color:rgba(0,245,212,0.4);color:#00f5d4;\">👤 <span id=\"z3-badge-chars\">0/45</span></div>" +
                    "</div>" +
                    "<button class=\"z3-close-btn\" id=\"z3-close-x-btn\">✕</button>" +
                "</div>" +
                "<div class=\"z3-tabs-bar\">" +
                    "<button class=\"z3-tab-btn active\" data-tab=\"0\">🎡 VÒNG QUAY NGỌC RỒNG</button>" +
                    "<button class=\"z3-tab-btn\" data-tab=\"1\">💾 SAO LƯU & KHÔI PHỤC</button>" +
                    "<button class=\"z3-tab-btn\" data-tab=\"2\">🎁 MÃ QUÀ TẶNG (GIFTCODE)</button>" +
                "</div>" +
                "<div class=\"z3-modal-body\">" +
                    // TAB 0: Wheel
                    "<div class=\"z3-tab-content active\" id=\"z3-tab-0\">" +
                        "<div class=\"z3-wheel-layout\">" +
                            "<div class=\"z3-wheel-box\">" +
                                "<div class=\"z3-wheel-pointer\"></div>" +
                                "<canvas id=\"z3-wheel-canvas\" width=\"250\" height=\"250\"></canvas>" +
                                "<div class=\"z3-wheel-center\">★</div>" +
                            "</div>" +
                            "<div class=\"z3-wheel-panel\">" +
                                "<div class=\"z3-panel-info\">" +
                                    "<div>Lượt quay: <b class=\"z3-spin-count\" id=\"z3-spin-rem-text\">3 / 3 lượt miễn phí</b></div>" +
                                    "<div style=\"font-size:11px;color:#9aa0b4;margin-top:4px;\">Hết lượt miễn phí? Bạn có thể dùng 200 BP để quay thêm không giới hạn!</div>" +
                                "</div>" +
                                "<button class=\"z3-spin-btn\" id=\"z3-spin-main-btn\">🎯 QUAY NGAY</button>" +
                                "<button class=\"z3-buy-spin-btn\" id=\"z3-buy-spin-btn\">➕ Đổi 200 BP lấy 1 lượt quay ngay</button>" +
                                "<div class=\"z3-prize-banner\" id=\"z3-prize-banner\">Quay để nhận Xu, Điểm BP hoặc Rương Rồng mở khóa tướng!</div>" +
                            "</div>" +
                        "</div>" +
                    "</div>" +
                    // TAB 1: Backup / Restore
                    "<div class=\"z3-tab-content\" id=\"z3-tab-1\">" +
                        "<div class=\"z3-backup-layout\">" +
                            "<div class=\"z3-card\">" +
                                "<div class=\"z3-card-title\"><span>📤</span> Xuất Mã Sao Lưu (Export)</div>" +
                                "<div class=\"z3-card-desc\">Bấm nút bên dưới để đóng gói toàn bộ Xu, Điểm BP, 45 nhân vật đã mở khóa và cài đặt game thành 1 mã bí mật. Hãy lưu mã này vào Ghi chú / Tin nhắn!</div>" +
                                "<textarea class=\"z3-textarea\" id=\"z3-export-textarea\" readonly placeholder=\"Mã sao lưu sẽ xuất hiện ở đây...\"></textarea>" +
                                "<button class=\"z3-btn z3-btn-export\" id=\"z3-btn-do-export\">📋 TẠO VÀ SAO CHÉP MÃ</button>" +
                            "</div>" +
                            "<div class=\"z3-card\">" +
                                "<div class=\"z3-card-title\"><span>📥</span> Khôi Phục Dữ Liệu (Import)</div>" +
                                "<div class=\"z3-card-desc\">Dán mã sao lưu (bắt đầu bằng Z3SAVE_...) vào ô dưới đây khi bạn xóa game cài lại để lấy lại toàn bộ quá trình chơi!</div>" +
                                "<textarea class=\"z3-textarea\" id=\"z3-import-textarea\" placeholder=\"Dán mã sao lưu Z3SAVE_... vào đây\"></textarea>" +
                                "<button class=\"z3-btn z3-btn-import\" id=\"z3-btn-do-import\">🔄 KHÔI PHỤC NGAY</button>" +
                            "</div>" +
                        "</div>" +
                    "</div>" +
                    // TAB 2: Giftcode
                    "<div class=\"z3-tab-content\" id=\"z3-tab-2\">" +
                        "<div class=\"z3-giftcode-layout\">" +
                            "<div class=\"z3-input-row\">" +
                                "<input class=\"z3-input\" id=\"z3-giftcode-input\" placeholder=\"NHẬP MÃ GIFTCODE...\" />" +
                                "<button class=\"z3-btn z3-btn-export\" id=\"z3-btn-redeem\">🎁 NHẬN THƯỞNG</button>" +
                            "</div>" +
                            "<div class=\"z3-codes-list\">" +
                                "<div style=\"font-weight:bold;margin-bottom:8px;color:#ffbe0b;\">DANH SÁCH GIFTCODE KHỞI ĐẦU:</div>" +
                                "<div class=\"z3-code-item\"><span class=\"z3-code-name\">DRAGONBALL</span><span class=\"z3-code-reward\">+10,000 Xu</span></div>" +
                                "<div class=\"z3-code-item\"><span class=\"z3-code-name\">SUPERHERO</span><span class=\"z3-code-reward\">+15,000 Xu & +100 BP</span></div>" +
                                "<div class=\"z3-code-item\"><span class=\"z3-code-name\">ZLEGENDS3</span><span class=\"z3-code-reward\">+20,000 Xu & +300 BP</span></div>" +
                                "<div class=\"z3-code-item\"><span class=\"z3-code-name\">THANHUYDIET</span><span class=\"z3-code-reward\">+30,000 Xu & +500 BP</span></div>" +
                                "<div class=\"z3-code-item\"><span class=\"z3-code-name\">HOANGKIM</span><span class=\"z3-code-reward\">+50,000 Xu & +1,000 BP</span></div>" +
                            "</div>" +
                        "</div>" +
                    "</div>" +
                "</div>" +
            "</div>";

        document.body.appendChild(overlay);

        // Reliable tap + click handler for iOS touch & desktop mouse with 350ms debounce
        function addTapListener(el, handler) {
            if (!el) return;
            var lastTriggerTime = 0;
            function triggerAction(e) {
                var now = Date.now();
                if (now - lastTriggerTime < 350) return;
                lastTriggerTime = now;
                if (e) {
                    e.stopPropagation();
                    if (e.type === "touchend" && e.cancelable) e.preventDefault();
                }
                handler(e);
            }
            el.addEventListener("click", triggerAction, false);
            el.addEventListener("touchend", triggerAction, false);
        }

        // Attach reliable tap listener to Trigger Button
        addTapListener(btn, openModal);

        // Stop pointer & touch start/move on btn from bubbling to canvas/document (bubble phase)
        var btnStopEvents = [
            "touchstart", "touchmove",
            "pointerdown", "pointermove",
            "mousedown", "mousemove"
        ];
        btnStopEvents.forEach(function (ev) {
            btn.addEventListener(ev, function (e) {
                e.stopPropagation();
            }, false);
        });

        // Close modal button
        var closeXBtn = document.getElementById("z3-close-x-btn");
        addTapListener(closeXBtn, closeModal);

        // Backdrop tap to close modal (only if tapping the dark background itself)
        function onBackdropTap(e) {
            if (e.target === overlay) {
                if (e.type === "touchend" && e.cancelable) e.preventDefault();
                closeModal();
            }
        }
        overlay.addEventListener("click", onBackdropTap, false);
        overlay.addEventListener("touchend", onBackdropTap, false);

        // Tabs
        var tabBtns = overlay.querySelectorAll(".z3-tab-btn");
        tabBtns.forEach(function (tBtn) {
            addTapListener(tBtn, function () {
                var idx = parseInt(tBtn.getAttribute("data-tab"), 10);
                switchTab(idx);
            });
        });

        // Wheel and Shop buttons
        addTapListener(document.getElementById("z3-spin-main-btn"), startSpin);
        addTapListener(document.getElementById("z3-buy-spin-btn"), async function () {
            var bp = await getLiveBP();
            if (bp < 200) {
                showToast("Bạn cần ít nhất 200 BP để đổi thêm lượt quay!");
                return;
            }
            await addBP(-200);
            var curRem = await getSpinsRemaining();
            await storageSet("Z3_WHEEL_FREE_SPINS", curRem + 1);
            showToast("Đã đổi thành công 1 lượt quay (+1 lượt)!");
            updateWheelUI();
        });

        // Account / Save data buttons
        addTapListener(document.getElementById("z3-btn-do-export"), exportSaveData);
        addTapListener(document.getElementById("z3-btn-do-import"), importSaveData);
        addTapListener(document.getElementById("z3-btn-redeem"), redeemGiftcode);

        // Stop all pointer/touch/mouse events bubbling UP through overlay to document/canvas
        // (Uses bubble phase { capture: false }, so children inside overlay receive their clicks freely)
        var overlayStopEvents = [
            "touchstart", "touchmove", "touchend", "touchcancel",
            "pointerdown", "pointermove", "pointerup", "pointercancel",
            "mousedown", "mousemove", "mouseup",
            "click", "dblclick", "contextmenu"
        ];
        overlayStopEvents.forEach(function (ev) {
            overlay.addEventListener(ev, function (e) {
                e.stopPropagation();
            }, false);
        });

        // Stop keyboard events from bubbling to document/C2 Keyboard plugin (fixes letter 'G' block)
        var stopKeyEvents = ["keydown", "keyup", "keypress"];
        stopKeyEvents.forEach(function (ev) {
            overlay.addEventListener(ev, function (e) {
                e.stopPropagation();
            }, false);
        });

        // Attach keyboard shield to all input and textarea elements explicitly
        var inputElements = overlay.querySelectorAll("input, textarea");
        inputElements.forEach(function (el) {
            stopKeyEvents.forEach(function (ev) {
                el.addEventListener(ev, function (e) {
                    e.stopPropagation();
                }, false);
            });
        });

        var giftInput = document.getElementById("z3-giftcode-input");
        if (giftInput) {
            giftInput.addEventListener("input", function () {
                this.value = this.value.toUpperCase();
            });
        }

        updateTriggerButtonVisibility();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", injectUI);
    } else {
        injectUI();
    }
})();
