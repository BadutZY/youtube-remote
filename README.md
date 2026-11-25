# YouTube Remote

Kendalikan YouTube dan YouTube Music di komputer lewat HP, tanpa alt tab dan tanpa mouse.
Chrome debug di komputer sudah login ke akun YouTube dan menerima klik sungguhan, sehingga HP cukup menampilkan hasilnya dalam antarmuka yang rapi.

## Fitur

Pemutar
- Putar/jeda, berikutnya, sebelumnya, seek, lompat 10 detik (tombol atau ketuk dua kali di gambar), volume, mute, ulangi (mati/playlist/satu lagu)
- Skip iklan dengan klik tepercaya
- Suka, tidak suka, subscribe (YouTube), acak (YouTube Music), kecepatan putar, layar penuh di komputer
- Timer tidur: jeda otomatis setelah 15 sampai 90 menit
- Daftar putar dari YouTube / YouTube Music, ketuk item untuk melompat

Cari
- Cari di YouTube atau YouTube Music, dengan filter (video, playlist, kanal; lagu, video, album, artis, playlist)
- Ketuk hasil untuk langsung memutar di komputer; ketuk playlist, album, kanal atau artis untuk membuka isinya
- Riwayat pencarian terakhir

Beranda dan Library
- Beranda, rekomendasi, langganan, riwayat, jelajah, rilis baru
- Library: playlist milik Anda dan isinya, video/lagu disukai, tonton nanti, album, artis
- Tombol "Putar semua" di dalam playlist atau album

Antrean HP
- Dari titik tiga di setiap item: Putar sekarang, Putar berikutnya, Tambah ke antrean HP
- Antrean ini berlaku untuk YouTube dan YouTube Music sekaligus. Item diputar otomatis saat lagu sekarang hampir habis, atau saat tombol Berikutnya ditekan.

Layar langsung (cadangan)
- Melihat tab YouTube di komputer dari HP, ketuk untuk klik, geser untuk gulir, ketik teks, Enter dan Hapus
- Dipakai untuk hal yang belum punya tombol sendiri

Tidak termasuk: membuat playlist dan tambah/hapus lagu di playlist.

## Cara pakai

1. Pasang Node.js versi 22 atau lebih baru.
2. Jalankan `start-chrome-debug.bat`, lalu login ke akun YouTube di jendela Chrome itu (cukup sekali).
3. Pasang userscript `youtube-skip-remote.user.js` di Tampermonkey (versi 3.0.0). Jika versi lama sudah terpasang, ganti isinya.
4. Jalankan server: `node server.js` (atau `npm start`).
5. Buka alamat yang tampil di terminal dari HP (satu WiFi), misalnya `http://192.168.x.x:3737/?pin=PIN`.
6. Biarkan minimal satu tab YouTube atau YouTube Music terbuka di Chrome debug.

PIN ada di `config.json`. Gunakan HP hanya lewat WiFi rumah.

## Cara kerja singkat

- Userscript melaporkan status pemutar (judul, posisi, suka, dll) dan menjalankan perintah dasar.
- Pencarian, beranda, library dan playlist dibaca dari dalam tab YouTube yang sudah login, lewat permintaan InnerTube (cookie akun dipakai otomatis), lalu ditampilkan sebagai daftar di HP.
- Memutar item = tab diarahkan ke halaman tontonan item tersebut, lalu dipastikan berputar.
- Suka, subscribe, layar penuh, acak = klik tepercaya lewat port debug Chrome.

## Catatan penting

- Jika YouTube mengubah tampilan, bagian yang terdampak bisa berhenti bekerja. Selector tombol ada di `lib/control.js` (klik) dan userscript (pembacaan status).
- Pembacaan data memakai struktur JSON internal YouTube dan bisa berubah. Jika satu halaman kosong atau salah, jalankan server dengan `YT_DUMP=1` (Windows: `set YT_DUMP=1` lalu `node server.js`). Balasan mentah disimpan di folder `debug/` untuk diperbaiki.
- Tombol "Cek koneksi Chrome dan akun" di tab Layar menampilkan status port debug dan login.
- Suka dan subscribe mengandalkan tombol di halaman, jadi paling rawan jika tampilan berubah.
- Perpindahan item memuat ulang halaman YouTube, jadi ada jeda 1 sampai 3 detik.
- Antrean HP berpindah saat sisa waktu sekitar 1 detik, sehingga ujung lagu bisa terpotong sedikit.
- Variabel lingkungan: `PORT` (default 3737), `PIN`, `CDP_PORT` (default 9222), `YT_DUMP`.

## Struktur

- `server.js` : server HTTP, status, antrean HP, timer tidur
- `lib/cdp.js` : koneksi Chrome DevTools Protocol
- `lib/yt.js` : membaca dan menguraikan data YouTube / YouTube Music
- `lib/control.js` : memutar item, klik tombol, layar langsung
- `public/` : tampilan HP (`index.html`, `style.css`, `app.js`)
- `youtube-skip-remote.user.js` : userscript untuk Tampermonkey
