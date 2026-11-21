# QA — Đơn chờ nhập kho trong 24 giờ

Chính sách cập nhật: 19/11/2026. Dùng Redis thử riêng cổng 16381, không chỉnh tồn hoặc hủy đơn trên Redis nguồn để kiểm thử.

## Tự động

npm test đã chạy thành công:

- FIFO, xử lý lại sau Node khởi động, hoàn tất lặp không trừ kho hai lần.
- Thiếu kho → WAITING_STOCK, không trừ một phần, không chiếm worker và không tăng số lượt khi chỉ quét kiểm tra kho.
- Cập nhật kho qua API sản phẩm → xếp lại một lần, xác nhận và trừ đúng kho.
- Hạn cố định 24 giờ từ createdAtMs; dùng timestamp quá hạn trong DB thử để kiểm tra, không chờ thực tế 24 giờ.
- Quá hạn tự chuyển CANCELLED, báo admin và khách hàng đúng một lần; hàng bổ sung sau hạn không tự xác nhận, không trừ kho.
- Hạn đi qua trong lúc processing cũng không được xác nhận muộn.
- Thông báo thiếu hàng/hết hạn không lặp theo lượt quét.
- Hai yêu cầu hủy đồng thời chỉ có một sự kiện/thông báo; đơn đang xử lý bị hủy thì finish bỏ qua, không trừ kho.
- Đơn hoàn tất không hủy; khách không được gọi API hủy của admin.
- Khách chỉ nhận thông báo của chính mình, lý do hủy hiển thị đúng; đọc thông báo không đánh dấu nhầm thông báo đến sau.
- Chuyển đổi đơn thiếu kho cũ sang trạng thái chờ, không đặt lại thời điểm đặt đơn hoặc nhân thông báo.
- Giữ các kiểm tra phân quyền, sửa/xóa sản phẩm, xuất/nhập và thanh thời gian xử lý.

## Giao diện đã thao tác

1. Tạo hai đơn cùng sản phẩm còn một chiếc trên DB QA: một đơn xác nhận, một đơn chờ nhập kho.
2. Admin thấy cảnh báo và chuông thông báo thiếu hàng.
3. Sửa tồn size S từ 0 lên 1 bằng form Sửa sản phẩm: đơn chờ tự chuyển xác nhận, lượt xử lý tăng từ 1 lên 2.
4. Tạo đơn QA khác thiếu hàng, mở form Hủy đơn, nhập lý do và xác nhận: trạng thái CANCELLED.
5. Đăng nhập tài khoản khách QA trên host riêng: thấy chuông thông báo hủy kèm lý do và trạng thái/lý do ở lịch sử đơn.
6. Bấm Đánh dấu đã đọc: badge hết chưa đọc.
7. Kiểm tra 390px: sau khi thu gọn biểu tượng lịch sử trên điện thoại, trang không tràn ngang.

Ảnh customer-stock-notifications.png là dữ liệu QA minh họa giao diện, không phải đơn khách thực hoặc minh chứng đã chờ 24h thực tế.
