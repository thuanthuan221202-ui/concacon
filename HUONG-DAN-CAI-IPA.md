# Hướng dẫn xuất file `Z_Legends_3.ipa` và cài đặt lên iPhone / iPad

Dự án này đã được cấu hình sẵn toàn bộ mã nguồn iOS gốc (`WKWebView` + `WKURLSchemeHandler` + `AVAudioSession` + khóa màn hình ngang + cảm ứng đa điểm game đối kháng + tự động chuyển đổi 3.525 file âm thanh `.ogg`/`.mp3` sang chuẩn Apple AAC `.m4a` + icon Goku pixel-art gốc).

---

## Bước 1: Đẩy bộ khung dự án lên GitHub (chỉ ~30 KB, mất 5 giây)

1. Đăng nhập vào https://github.com/new (tạo tài khoản miễn phí nếu chưa có).
2. Đặt tên repository tùy ý (ví dụ: `z-legends-3-ios`), chọn **Public** (để máy ảo macOS của GitHub miễn phí không giới hạn), **không** tích chọn *Add a README file*, rồi nhấn **Create repository**.
3. Copy đường dẫn HTTPS của repo (dạng `https://github.com/<tên-bạn>/z-legends-3-ios.git`).
4. Mở thư mục `d:\Downloads\Z-Legends-3-iOS` trên máy tính, nhấp đúp chạy file **`day-len-github.bat`**, dán đường dẫn repo vừa copy vào và nhấn **Enter** (nếu hiện bảng đăng nhập GitHub thì bấm *Sign in with your browser*).

---

## Bước 2: Gắn file `.apk` để GitHub tự động biên dịch ra `.ipa`

1. Trên trang GitHub repository của bạn, nhìn sang cột bên phải mục **Releases** -> bấm **Create a new release**.
2. Tại ô **Choose a tag**, gõ `v2.7.7` rồi bấm chọn dòng **+ Create new tag: v2.7.7 on publish**.
3. Tại ô **Attach binaries by dropping them here or selecting them** bên dưới:
   - Kéo thả file gốc `d:\Downloads\Z LEGENDS 3 v.2.7.7 - New Points System + DUBLAGEM BRASILEIRA - NORMAL VERSION (Ingles Version).apk` (213 MB) vào và đợi thanh tải lên chạy xong 100%.
4. Nhấn nút màu xanh **Publish release**.
5. Ngay lập tức, tab **Actions** trên GitHub sẽ tự động chạy tiến trình **Build Z Legends 3 iOS (.ipa)** trên máy chủ macOS (mất khoảng **4 – 6 phút**).
6. Khi tab **Actions** báo tích xanh hoàn tất, bạn quay lại mục **Releases** và tải trực tiếp file **`Z_Legends_3.ipa`** về máy! *(Hoặc tải trong mục Artifacts của tab Actions).*

---

## Bước 3: Cài file `Z_Legends_3.ipa` vào iPhone / iPad (từ Windows)

Cách đơn giản và ổn định nhất trên Windows là dùng **Sideloadly**:

1. Cài đặt **iTunes** và **iCloud** bản chính thức từ trang chủ Apple (bản cài `.exe`, không phải bản từ Microsoft Store) nếu máy bạn chưa có driver kết nối iPhone.
2. Tải và cài đặt **Sideloadly** tại: https://sideloadly.io/
3. Cắm cáp kết nối iPhone / iPad vào máy tính Windows (bấm *Tin cậy máy tính này / Trust* trên màn hình iPhone).
4. Mở **Sideloadly**:
   - Ô **IPA**: kéo thả file **`Z_Legends_3.ipa`** vừa tải về vào.
   - Ô **Apple ID**: nhập email Apple ID cá nhân của bạn.
   - Nhấn nút **Start** và nhập mật khẩu Apple ID + mã xác thực 2 lớp (chứng chỉ cá nhân miễn phí của Apple).
5. Sau khi Sideloadly báo **Done**, trên iPhone / iPad làm 2 thao tác cấp quyền một lần:
   - Vào **Cài đặt (Settings) -> Cài đặt chung (General) -> Quản lý VPN & Thiết bị (VPN & Device Management)** -> chọn email Apple ID của bạn -> bấm **Tin cậy (Trust)**.
   - *(Nếu dùng iOS 16 trở lên)* Vào **Cài đặt -> Quyền riêng tư & Bảo mật (Privacy & Security)** -> kéo xuống cuối bật **Chế độ nhà phát triển (Developer Mode)** -> Khởi động lại máy.
6. Mở game **Z Legends 3** trên màn hình chính và chiến!

> **Lưu ý về hạn 7 ngày của Apple:** Với Apple ID miễn phí, Apple giới hạn ứng dụng sideload có hiệu lực 7 ngày. Hết 7 ngày bạn chỉ cần cắm lại vào Sideloadly bấm Start (hoặc bật chế độ tự động làm mới qua Wi-Fi của Sideloadly / SideStore) — **dữ liệu save game mở khóa nhân vật vẫn được giữ nguyên** miễn là bạn không xóa app trước khi cài đè. Nếu máy bạn có **TrollStore**, bạn cài trực tiếp `Z_Legends_3.ipa` vĩnh viễn không bao giờ hết hạn.
