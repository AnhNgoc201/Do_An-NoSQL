> Tài liệu tham khảo từ phiên bản trước. Trang Redis Lab đã được bỏ theo yêu cầu; ứng dụng hiện là cửa hàng và quản trị hàng đợi tại /admin.html#queue. Không dùng các đường dẫn/màn hình Redis Lab trong tài liệu này làm mô tả phiên bản hiện tại.

# Kết quả QA kỹ thuật — 29/10/2026

## Phạm vi kiểm tra đã thực hiện

Môi trường thử tách khỏi Redis đang phục vụ cửa hàng: redis-lab-qa (cổng 16381), redis-lab-regression (16382), redis-lab-restore-qa (16383). Không FLUSHDB hoặc chỉnh kho/đơn của DB 0/1 trên redis-orders.

### Kiểm thử tự động Node/Redis: Đạt

Chạy npm test trên database rỗng của redis-lab-regression:

- FIFO, resume processing, hoàn tất lặp không trừ kho hai lần.
- Hai khách cùng đặt chiếc cuối: một hoàn tất, một thất bại, tồn không âm.
- Đơn nhiều món: không trừ kho một phần khi thiếu một món.
- Tạo/sửa/xóa sản phẩm, kiểm tra tồn thay đổi, chặn xóa sản phẩm có đơn đang xử lý.
- Xác thực/đăng xuất, phân quyền quản trị, cách ly đơn khách, kiểm tra Origin.
- API lab chỉ quản trị, từ chối xem auth:* hoặc đường dẫn ngoài phạm vi.
- Đọc String, Hash, List, Set, Sorted Set, Stream và TTL; tạo fixture không reset key cũ.
- Snapshot đọc chỉ số Redis thực; các URL hướng dẫn trả về nội dung.
- Xuất/nhập logic vào DB 3 trống, giữ kiểu/value/TTL; không xuất auth:*, từ chối ghi đè DB có dữ liệu và từ chối DB 0/1.
- Endpoint lỗi giả lập đã bỏ; cấu hình giả lập cũ không còn tác động xử lý.

### RDB backup / restore thật: Đạt

Đã chạy scripts/backup-rdb.ps1 trên container regression và scripts/restore-rdb.ps1 để tạo container mới từ RDB. Đối chiếu dữ liệu logic sau restore (không dùng thứ tự nội bộ serialization Hash làm tiêu chí):

| Database | Key đối chiếu tại thời điểm kiểm tra | Loại key có mặt | Kết quả |
|---|---:|---|---|
| DB 1 thử | 56 | String, Hash, List, Set, Sorted Set, Stream | TYPE và giá trị khớp; TTL phù hợp |
| DB 3 thử | 44 | String, Hash, List, Set, Sorted Set, Stream | TYPE và giá trị khớp; TTL phù hợp |

Các key TTL đã hết hạn có thể làm số lượng giảm theo thời gian. Kết quả máy đọc nằm trong qa-artifacts/rdb-comparison.json. RDB chỉ chứa dữ liệu QA trong phép thử này; không đính kèm file backup vào báo cáo công khai.

### Kiểm tra giao diện: Đạt trong phạm vi đã thao tác

- Tổng quan mới, đăng nhập quản trị → quay lại Redis Lab.
- Tạo bộ key thực hành; sao chép PING báo thành công.
- Chọn nhóm lab:, xem Set hiển thị members/cursor đúng, TYPE và TTL rõ ràng.
- Hàng đợi hiển thị hai đơn được tạo thật trong DB QA; nút tiếp tục worker đổi trạng thái sang đang chạy.
- Các chỉ số Redis version, memory, DBSIZE và AOF được đọc thật.
- Màn hình 390px: trang import/sao lưu và trình xem key không tràn ngang; navigation cuộn ngang.
- Cửa hàng mở đúng tại /shop.html, sản phẩm hiện và link hash giữ nguyên đường dẫn shop.

Một tab kiểm tra bị lỗi tài nguyên của trình duyệt; mở tab mới đã tải được cả Redis Lab và /shop.html. Backend vẫn trả HTTP 200 trong lúc đó.

## Không đánh đồng với các bài nhóm cần thu bằng chứng

Chưa thao tác import/export trên P3X desktop trong lượt QA này; chưa chụp bộ ảnh P3X cho báo cáo và chưa sửa trực tiếp file Word gốc. Bảng kiểm thử trong KICH-BAN-KIEM-THU.md để nhóm ghi kết quả thao tác thực tế, không tự điền Đạt dựa vào test Node. Cần kiểm chứng menu và tính năng trên phiên bản P3X nhóm đang dùng.
