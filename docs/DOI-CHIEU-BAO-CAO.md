> Tài liệu tham khảo từ phiên bản trước. Trang Redis Lab đã được bỏ theo yêu cầu; ứng dụng hiện là cửa hàng và quản trị hàng đợi tại /admin.html#queue. Không dùng các đường dẫn/màn hình Redis Lab trong tài liệu này làm mô tả phiên bản hiện tại.

# Đối chiếu ứng dụng với báo cáo gốc

## 1. Tên đề tài cần giữ

“Tìm hiểu công cụ P3X Redis UI để quản trị và khai thác Redis trong Quản lý hàng đợi xử lý đơn hàng trực tuyến và xây dựng ứng dụng minh họa”. Không đổi tên thành website bán quần áo, không đổi môn thành phát triển web.

## 2. Vai trò và phạm vi

- **P3X Redis UI:** công cụ được tìm hiểu và sử dụng để quản trị/khai thác dữ liệu.
- **Redis Server:** lưu dữ liệu nghiệp vụ, hàng đợi và chỉ mục; thực thi Lua nguyên tử.
- **Ứng dụng Express/Node:** tiếp nhận đơn và chạy worker tuần tự; tạo tình huống cho P3X quan sát.
- **Cửa hàng NOSQL BOUTIQUE:** giao diện nhập đơn minh họa. Đăng nhập, giỏ hàng, liên hệ chỉ là chức năng phụ trợ.
- **Trang Redis Lab mới:** bản đồ học tập, quan sát dữ liệu và hướng dẫn kiểm chứng. Đây là trang tự viết, không được mô tả là giao diện P3X.

## 3. Đối chiếu từng mục báo cáo

| Mục báo cáo | Phần chuẩn bị trong dự án | Minh chứng nhóm cần thu |
|---|---|---|
| 1.1 Redis, kiểu dữ liệu, hàng đợi | README và bản đồ key trên Redis Lab | Sơ đồ kiến trúc, bảng key/type/vai trò |
| 1.2–1.3 P3X, cài đặt/kết nối | Sổ tay P3X, lệnh đúng container thực tế | Version P3X, cửa sổ kết nối, PONG, DB đúng |
| 1.4 So sánh RedisInsight | Phần lý thuyết gốc cần đối chiếu phiên bản hiện dùng | Chỉ so sánh tính năng đã xác minh; không tự khẳng định công cụ nào nhanh hơn |
| 1.5 Khả năng ứng dụng | Luồng queue/processing, giới hạn worker | Giải thích lợi ích tiếp nhận tách khỏi xử lý |
| 2.1 Giao diện công cụ | Thao tác trên ứng dụng P3X thật | Ảnh P3X, không dùng trang Redis Lab thay thế |
| 2.2 Các kiểu key, TTL | Bộ lab: và hướng dẫn lệnh | Tạo/sửa/xóa và TYPE/TTL trong P3X |
| 2.3 Cơ bản, nâng cao, thống kê | SCAN, HGETALL, LRANGE, SCARD, SINTER, ZRANGEBYSCORE, Stream | Console có key/mã đơn thật và kết quả |
| 2.4 Quản trị/giám sát | INFO, DBSIZE, bảng metrics | Ảnh P3X Monitoring + Console; phân biệt toàn server và DB |
| 2.5 Import/export | P3X export/import; CLI bổ sung định dạng riêng | Tệp P3X thực xuất, trước/sau ở DB thử, version công cụ |
| 2.6 Backup/restore | BGSAVE, scripts PowerShell, restore container riêng | INFO persistence, file RDB, hash, kết nối thử và key phục hồi |
| Ứng dụng minh họa | Shop + API + worker + Redis Lab | TC01–04: FIFO, thiếu kho, nhiều món, resume Node |

## 4. Các chi tiết cũ cần sửa trong tài liệu

1. Container hiện tại là **redis-orders**; P3X chạy desktop. Không dùng câu lệnh docker start redis-server hoặc p3x-redis-ui nếu các container đó không tồn tại.
2. DB 0 là bộ mẫu tĩnh để viết tài liệu; DB 1 là dữ liệu ứng dụng. Khi trình bày tích hợp, ảnh và truy vấn phải nhất quán cùng DB 1.
3. Mã đơn thật hiện dạng ORD-UUID; khách KH-… và sản phẩm SP-…/SP-DEMO-…. Nếu dùng ORD001/KH001/SP001 từ DB 0, ghi rõ là dữ liệu mẫu tĩnh, không khẳng định đó là đơn vừa đặt trên web.
4. Không còn bộ chọn lỗi giả lập. FAILED hiện minh họa thiếu kho thực tế. Lỗi hạ tầng không tự biến thành lỗi nghiệp vụ; worker dừng và giữ processing.
5. Xử lý mặc định **10 giây/đơn** theo .env, không dùng con số 3 giây từ bản cũ, không gọi đây là benchmark hiệu năng Redis.
6. Xác nhận COMPLETED nghĩa kiểm tra đủ hàng và trừ kho, không có nghĩa đã thanh toán/giao hàng.
7. Backup RDB là chức năng Redis; P3X có thể gửi BGSAVE và quan sát. Việc sao chép file container và khởi tạo Redis phục hồi dùng Docker/script ngoài P3X.
8. P3X export JSON và bản xuất logic redis-lab-dump-v1 là hai định dạng khác nhau. Bản xuất logic không bao gồm auth:*, không phải bản full-app.
9. Nếu trình bày AOF, đọc INFO persistence thực tế rồi ghi đang bật/tắt. Không tự bật AOF trên dữ liệu hiện có chỉ để có ảnh.
10. Stream là lịch sử sự kiện; queue chính dùng List với RPUSH/LMOVE. Không ghi đã triển khai Redis Streams consumer groups.

## 5. Giới hạn cần công bố

- Một backend/worker local. Chưa kiểm thử/thiết kế nhiều worker hoặc hệ thống phân tán.
- Tồn kho được trừ ở lượt xử lý, chưa giữ chỗ khi tiếp nhận; hai khách đều có thể đặt nhưng không phải cả hai sẽ được xác nhận.
- Lua bảo vệ phần kiểm tra/trừ kho trong Redis; không bao phủ giao dịch với cổng thanh toán bên ngoài.
- Resume xử lý khi Node khởi động lại; mất Redis/điện đột ngột còn phụ thuộc cấu hình persistence.
- Số liệu quan sát đọc tại các thời điểm, không phải báo cáo transaction nhất quán toàn DB.
- Cần xác minh menu import/export và so sánh RedisInsight trên phiên bản nhóm thực sự dùng.
- Chưa có dịch vụ giao nhận, thanh toán, gửi email thật. Đây không phải phạm vi đề tài.

## 6. Việc đã chuẩn bị và việc cần nhóm làm

Đã chuẩn bị mã ứng dụng và tài liệu quy trình; test tự động và QA kỹ thuật được ghi trong docs/QA-KY-THUAT.md sau khi chạy. Phần văn bản gốc người dùng cung cấp vẫn giữ nguyên; tài liệu này là bản hướng dẫn chỉnh báo cáo, không phải bản Word đã được dàn trang lại.

Nhóm cần tự thao tác P3X, ghi version và chụp bằng chứng cùng một lượt dữ liệu. Không đưa mật khẩu .env, auth Hash, session token, file RDB toàn server vào ảnh/file công khai.

## 7. Đoạn mô tả ứng dụng có thể đưa vào báo cáo

Ứng dụng minh họa sử dụng Node.js/Express để tiếp nhận đơn hàng và Redis để lưu trữ dữ liệu, tổ chức hàng đợi. Thông tin đơn hàng và tồn kho được lưu bằng Hash; List quản lý đơn chờ và đơn đang xử lý; Set tạo chỉ mục trạng thái; Sorted Set lập chỉ mục thời gian tạo; Stream ghi lại các sự kiện. Worker xử lý tuần tự, kiểm tra toàn bộ tồn kho theo size và chỉ trừ kho khi đơn có đủ hàng. Nhóm sử dụng P3X Redis UI kết nối cùng database để quan sát, truy vấn và kiểm chứng thay đổi dữ liệu. Cửa hàng quần áo là tình huống nhập liệu minh họa; nội dung nghiên cứu tập trung vào P3X và Redis.
