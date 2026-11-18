@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   DAY DU AN Z LEGENDS 3 iOS LEN GITHUB DE XUAT FILE .IPA
echo ============================================================
echo.
echo Buoc chuan bi: Hay tao 1 repository TRONG tren https://github.com/new
echo (Khuyen khich chon Public de GitHub Actions macOS mien phi khong gioi han)
echo.
set /p REPO_URL="Dan link GitHub repo cua ban vao day (VD: https://github.com/tenban/z-legends-3-ios.git): "

if "%REPO_URL%"=="" (
    echo [Loi] Ban chua nhap link repository!
    pause
    exit /b 1
)

git remote remove origin >nul 2>&1
git remote add origin "%REPO_URL%"
git branch -M main
echo.
echo Dang day ma nguon len GitHub (neu co cua so dang nhap GitHub hien ra, hay nhan Sign in with browser)...
git push -u origin main --force

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [THANH CONG!] Da day du an len GitHub!
    echo Bay gio ban chi can:
    echo   1. Mo trang GitHub repo cua ban -^> nhan vao muc "Releases" ^(goc phai^) -^> "Create a new release"
    echo   2. O "Choose a tag": go v2.7.7 roi chon "+ Create new tag: v2.7.7 on publish"
    echo   3. Keo tha file APK Z LEGENDS 3 ^(trong d:\Downloads^) vao o "Attach binaries"
    echo   4. Nhan nut xanh "Publish release"
    echo   5. Doi khoang 5 phut, GitHub Actions se tu bien dich va gan file Z_Legends_3.ipa ngay trong muc Releases!
) else (
    echo.
    echo [Co loi khi push] Kiem tra lai link repo hoac quyen dang nhap GitHub.
)
echo.
pause
