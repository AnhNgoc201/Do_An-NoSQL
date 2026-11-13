> Tài liệu tham khảo từ phiên bản trước. Trang Redis Lab đã được bỏ theo yêu cầu; ứng dụng hiện là cửa hàng và quản trị hàng đợi tại /admin.html#queue. Không dùng các đường dẫn/màn hình Redis Lab trong tài liệu này làm mô tả phiên bản hiện tại.

# Kịch bản kiểm thử và thu thập minh chứng

Đây là hướng dẫn và kết quả **mong đợi**, không phải kết quả thực nghiệm đã đo của nhóm. Chỉ điền Đạt/Không đạt sau khi chạy và lưu bằng chứng thực tế. Không giả số đo hiệu năng, ảnh P3X hoặc xác nhận phục hồi.

## Chuẩn bị

- Redis nguồn redis-orders, DB 1; P3X kết nối cùng DB.
- Node chạy npm start, /api/health trả PONG; mặc định thời gian worker 10 giây.
- Tài khoản quản trị và hai tài khoản khách (A/B, hai cửa sổ trình duyệt hoặc một cửa sổ ẩn danh).
- Tạo sản phẩm thử riêng qua quản trị, ghi lại ID. Không dùng tồn kho của mẫu đã chụp trong báo cáo để tránh khó đối chiếu.
- Chụp trước/sau trong cùng một DB, ghi rõ mã đơn và productId.

## TC01 — FIFO, nhiều đơn đang chờ

1. Tạm dừng nhận đơn ở /#queue. Đợi processing trống.
2. Tạo ba đơn liên tiếp từ shop (đủ tồn kho cho cả ba).
3. P3X: LRANGE order:queue 0 -1; chụp thứ tự A/B/C. HGETALL từng Hash phải PENDING, SMEMBERS order:status:PENDING chứa các ID.
4. Tiếp tục worker. Quan sát processing mỗi lượt, Hash status và Stream.
5. Mong đợi: thứ tự bắt đầu xử lý A→B→C theo hàng đợi, cuối cùng COMPLETED, queue/processing rỗng hoặc key không tồn tại. Chỉ so sánh các đơn của lượt kiểm thử, tránh lẫn đơn cũ.

Minh chứng: ảnh List chờ, ảnh processing, Stream thể hiện thứ tự và Hash kết quả.

## TC02 — Hai khách tranh chiếc cuối

1. Tạo sản phẩm thử S tồn 1 (size khác tùy ý); ghi stock:S và tổng tồn.
2. Tạm dừng worker, đợi processing trống. Hai khách đăng nhập riêng, cùng thêm sản phẩm size S vào giỏ **trước khi xử lý bất kỳ đơn nào**.
3. A đặt 1 chiếc, B đặt 1 chiếc. Vì kho chưa trừ nên cả hai yêu cầu được tiếp nhận; kiểm tra hai ID trong queue.
4. Tiếp tục xử lý. P3X đối chiếu Hash đơn, stock:S, Set và Stream.
5. Mong đợi: một COMPLETED, một FAILED với OUT_OF_STOCK; stock:S=0, tổng tồn giảm đúng 1, không âm. Đơn FAILED không trừ kho.

Đây là cạnh tranh nhu cầu tồn kho được xử lý tuần tự. Không khẳng định đã kiểm thử tải lớn hoặc nhiều worker.

## TC03 — Đơn nhiều món, không trừ một phần

1. Tạo X size S tồn 1 và Y size S tồn 5. Tạm dừng nhận đơn, processing trống.
2. Khách A đặt X×1 trước. Khách B đặt một đơn gồm X×1 và Y×2, khi kho chưa thay đổi.
3. Tiếp tục xử lý. A hoàn tất, X hết hàng. B thất bại do X.
4. Mong đợi: tồn Y vẫn 5, không giảm 2. Hash B FAILED; không có trừ kho một phần của đơn B.

## TC04 — Tiếp tục sau khi Node dừng

1. Đặt một đơn đủ hàng; quan sát ID trong order:processing, ghi tồn trước xử lý.
2. Dừng đúng tiến trình Node bằng Ctrl+C khi đơn đang xử lý; giữ Docker Redis hoạt động.
3. P3X: đơn vẫn nằm processing, status PROCESSING. Chạy npm start lại.
4. Mong đợi: đơn hoàn tất, biến mất khỏi processing, tồn chỉ giảm đúng số lượng mua một lần; không mất đơn.

Phân biệt với Redis crash: bài này chứng minh resume khi Node khởi động lại; độ bền khi Redis/host mất điện còn phụ thuộc RDB/AOF đang cấu hình. Không gọi đây là đảm bảo exactly-once tổng quát cho thanh toán hoặc hệ thống phân tán.

## TC05 — TTL và thao tác key P3X

Tạo lab: từ trang Thực hành P3X, xem GET/TTL lab:note; chụp TTL gần 120, giảm theo thời gian, hết hạn → -2. Thêm/sửa/xóa field ở lab:order:LAB001 và key lab:order:LAB001, dùng TYPE/EXISTS đối chiếu. Chụp từng kiểu dữ liệu theo sổ tay.

## TC06 — Import/export và phục hồi

### A. P3X

Xuất key thực hành bằng P3X; nhập cùng tệp vào DB 3 trống. Ghi version P3X, GUI Angular/React, phạm vi key, type/value/TTL trước/sau. Không đánh dấu Đạt chỉ từ thông báo import thành công.

### B. Công cụ CLI (định dạng riêng)

Dừng worker và không sửa dữ liệu khi export. Xuất bằng data-transfer.js; nhập vào DB thử >=2 trống. Đối chiếu tổng key được xuất/nhập, kiểm tra một key mỗi kiểu. Key đã hết hạn được bỏ qua, phải ghi nhận lý do chênh lệch.

### C. RDB

Trong PowerShell ở thư mục dự án:

```powershell
powershell -File scripts/backup-rdb.ps1
# Thay đường dẫn bằng thư mục vừa in ra:
powershell -File scripts/restore-rdb.ps1 -BackupDirectory .\backups\rdb-THU_MUC_VUA_TAO
```

- Script BGSAVE và kiểm tra xong mới sao chép. Chụp INFO persistence, đường dẫn backup và hash.
- Restore tạo redis-lab-restore-* trên cổng 6381. P3X thêm kết nối mới, chọn DB 1.
- Đối chiếu TYPE, nội dung Hash/List/Set/ZSet/Stream giữa snapshot trước và restore; TTL trôi theo thời gian thực.
- Đừng đặt đơn hay chỉnh dữ liệu nguồn giữa lúc chụp đối chiếu nếu muốn tổng key khớp.
- RDB có tài khoản/phiên; không đưa vào file nộp công khai. Sau khi xong có thể dừng container thử bằng `docker stop <TEN_CONTAINER_THU>`; không dừng nhầm redis-orders.

## Bảng ghi kết quả do nhóm điền

| Mã | Thời gian/DB | Mã đơn hoặc key | Kết quả thật | Đạt/Không đạt | File ảnh minh chứng |
|---|---|---|---|---|---|
| TC01 | Chưa chạy | | | | |
| TC02 | Chưa chạy | | | | |
| TC03 | Chưa chạy | | | | |
| TC04 | Chưa chạy | | | | |
| TC05 | Chưa chạy | | | | |
| TC06A P3X | Chưa chạy | | | | |
| TC06B CLI | Chưa chạy | | | | |
| TC06C RDB | Chưa chạy | | | | |

Kết quả test kỹ thuật tự động được ghi riêng; không dùng nó thay cho bảng thao tác P3X của nhóm.

## Kịch bản thuyết trình gợi ý 10–12 phút

1. 1 phút: mục tiêu đề tài, P3X khác gì web/Redis/worker.
2. 2 phút: P3X kết nối đúng DB, Hash đơn, List queue/processing, Set trạng thái, ZSet thời gian, Stream sự kiện.
3. 3 phút: TC01 và TC02, đối chiếu key trước/sau.
4. 1 phút: key lab:, TTL và truy vấn nâng cao.
5. 2 phút: import/export, monitoring và ảnh backup/restore đã làm.
6. 1 phút: kết luận đúng phạm vi, giới hạn một worker và persistence theo cấu hình thực tế.
