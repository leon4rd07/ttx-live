# Memasang TTX Live di VM Google Cloud

Susunannya: Node berjalan sebagai service systemd di `127.0.0.1:3000`, dan
Apache di depan membuka port 80 lalu meneruskan ke sana, termasuk WebSocket.
Apache tidak menjalankan aplikasinya, dia hanya pintu depan.

## Baca ini dulu: soal HTTPS

Dengan **IP publik saja, tidak ada HTTPS**. Tidak ada otoritas sertifikat yang
menerbitkan sertifikat tepercaya untuk alamat IP biasa. Pilihannya dua, dan
keduanya punya harga:

**Jalan HTTP biasa.** Peserta tidak melihat halaman peringatan apa pun, hanya
tulisan "Not secure" di bilah alamat. Lancar, tapi seluruh lalu lintas terbuka,
termasuk **kata sandi fasilitator saat Anda membuka ruangan**. Untuk latihan
berisi skenario insiden bank, ini perlu Anda sampaikan ke yang berwenang, bukan
diputuskan sendiri.

**Sertifikat buatan sendiri.** Jangan. Setiap peserta disambut layar merah
peringatan keamanan dan harus menekan Advanced lalu Proceed. Jauh lebih buruk
daripada halaman ngrok yang kemarin Anda hindari.

**Jalan ketiga, dan ini yang saya sarankan:** ambil satu nama host gratis yang
menunjuk ke IP VM, misalnya lewat DuckDNS, lalu jalankan certbot. Hasilnya
HTTPS sungguhan, gembok hijau, tanpa peringatan apa pun, tanpa biaya. Nama
hostnya juga lebih enak dicetak di poster daripada deretan angka IP. Tambahan
kerjanya sekitar sepuluh menit.

## 1. Siapkan VM

Debian 12 atau Ubuntu 22.04, mesin terkecil sudah cukup. Aplikasi ini satu
proses Node tanpa basis data.

```bash
sudo apt update
sudo apt install -y nodejs npm apache2 git
node --version     # harus 18 ke atas
```

Kalau versinya di bawah 18, pasang dari NodeSource, jangan dari apt bawaan.

## 2. Buka port 80 di firewall GCP

Dari mesin yang punya `gcloud`, atau lewat konsol GCP:

```bash
gcloud compute firewall-rules create ttx-live-allow-http \
  --project=PROJECT_ANDA \
  --allow=tcp:80 \
  --target-tags=ttx-live \
  --description="TTX Live, dibuka hanya selama periode latihan"
```

lalu pasang tag `ttx-live` pada VM-nya. **Catat nama aturan ini.** Setelah
latihan selesai, hapus dengan `gcloud compute firewall-rules delete
ttx-live-allow-http` supaya tidak ada yang menganggur terbuka.

## 3. Ambil kode dan build

```bash
sudo useradd --system --home /opt/ttx-live --shell /usr/sbin/nologin ttx
sudo git clone https://github.com/leon4rd07/ttx-live.git /opt/ttx-live
cd /opt/ttx-live
sudo npm install
sudo npm run build
sudo chown -R ttx:ttx /opt/ttx-live
```

## 4. Variabel lingkungan

```bash
sudo install -d -m 750 /etc/ttx-live
sudo cp /opt/ttx-live/deploy/ttx-live.env.example /etc/ttx-live/ttx-live.env
sudo chmod 640 /etc/ttx-live/ttx-live.env
sudo nano /etc/ttx-live/ttx-live.env
```

Isi minimal `HOST_KEY`. Sisanya sudah berisi default yang benar.

Berkas ini **tidak boleh masuk git**. Yang ada di repo hanya contohnya.

## 5. Jalankan sebagai service

```bash
sudo cp /opt/ttx-live/deploy/ttx-live.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ttx-live
sudo systemctl status ttx-live
```

Periksa dari dalam VM sebelum menyentuh Apache:

```bash
curl -I http://127.0.0.1:3000/
```

Harus menjawab `200`. Kalau tidak, `journalctl -u ttx-live -n 50` menunjukkan
sebabnya.

## 6. Apache di depannya

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel headers
sudo cp /opt/ttx-live/deploy/ttx-live.conf /etc/apache2/sites-available/
sudo nano /etc/apache2/sites-available/ttx-live.conf    # isi ServerName
sudo a2dissite 000-default
sudo a2ensite ttx-live
sudo apache2ctl configtest
sudo systemctl reload apache2
```

`proxy_wstunnel` adalah yang paling sering terlupa. Tanpa modul itu halamannya
terbuka normal tapi ruangan tidak pernah tersambung.

## 7. Uji dari luar

Buka `http://IP_PUBLIK/host` dari kuota ponsel, bukan dari dalam kantor. Yang
harus Anda lihat: pojok bilah menampilkan nomor build, dan tulisan
"Menyambung ulang" **tidak** menetap. Kalau tulisan itu tidak hilang hilang,
WebSocketnya tidak lolos dan tersangkanya `proxy_wstunnel`.

Lalu masuk sebagai peserta dari perangkat lain dan pastikan kursinya terisi.

## Memperbarui kode nanti

```bash
cd /opt/ttx-live
sudo git pull
sudo npm install
sudo npm run build
sudo systemctl restart ttx-live
```

## Setelah latihan selesai

```bash
sudo systemctl stop ttx-live
gcloud compute firewall-rules delete ttx-live-allow-http
```
