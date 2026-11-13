# Hướng dẫn chạy cửa hàng NoSQL trên Windows

## 1. Chuẩn bị

- Cài Git, Node.js 24 và Docker Desktop.
- Mở Docker Desktop và chờ Docker khởi động.
- Clone repo rồi mở **Command Prompt (CMD)** trong thư mục chứa `package.json` của ứng dụng. Nếu repo chứa nhiều thư mục, mở CMD trong `order-queue-app`.

## 2. Tạo Redis lần đầu

Chạy lệnh sau trong CMD.

```cmd
docker run -d --name redis-orders -p 127.0.0.1:6379:6379 -v redis-orders-data:/data redis:7.4 redis-server --appendonly yes
docker exec redis-orders redis-cli ping
```

Khi lệnh cuối trả về `PONG`, Redis đã sẵn sàng. Nếu máy đã có container `redis-orders`, dùng `docker start redis-orders` rồi kiểm tra lại bằng lệnh `ping` ở trên.

## 3. Tạo cấu hình riêng

Trong thư mục chứa `package.json`, tạo file tên `.env` và điền các dòng sau. Thay giá trị `ADMIN_PASSWORD` bằng mật khẩu bạn tự chọn, ít nhất 12 ký tự.

```dotenv
PORT=3000
REDIS_URL=redis://127.0.0.1:6379/1
ADMIN_EMAIL=admin@nosql.local
ADMIN_PASSWORD=MAT_KHAU_RIENG_CUA_BAN
```

Tài khoản admin được tạo trong Redis ở lần chạy đầu. Giữ file `.env` trên máy của bạn và để Git bỏ qua file này.

## 4. Cài thư viện và mở web

```cmd
npm ci
npm start
```

Giữ CMD mở khi dùng web. Khi thấy `Backend: http://localhost:3000`, mở trang theo vai trò.

| Vai trò | Trang | Cách đăng nhập |
|---|---|---|
| Admin | [Quản trị](http://localhost:3000/admin.html) | Dùng email và mật khẩu trong `.env` |
| Nhân viên kho | [Vận hành](http://localhost:3000/fulfillment.html) | Dùng tài khoản kho do admin tạo |
| Nhân viên giao hàng | [Vận hành](http://localhost:3000/fulfillment.html) | Dùng tài khoản giao hàng do admin tạo |
| Khách hàng | [Cửa hàng](http://localhost:3000/) | Tạo tài khoản qua mục đăng nhập của cửa hàng |

## 5. Nạp dữ liệu và thử quy trình

1. Đăng nhập admin, vào **Sản phẩm** và bấm **Thêm bộ 12 mẫu quần áo**.
2. Vào **Vận hành → Nhân viên** để tạo tài khoản kho và giao hàng. Bạn cũng có thể dùng admin để thử cả hai công đoạn.
3. Đăng nhập tài khoản khách, chọn sản phẩm và đặt một đơn. Khi đơn đủ hàng, hệ thống tự xác nhận và đưa vào hàng đợi đóng gói.
4. Trong **Vận hành → Đóng gói**, bấm **Nhận đơn tiếp theo**, rồi **Đã đóng gói xong**. Sau đó vào **Giao hàng**, bấm **Nhận đơn tiếp theo**, rồi **Đã giao thành công**.

Repo có bộ sản phẩm mẫu. Đơn hàng, tồn kho đã chỉnh và tài khoản của người khác nằm trong Redis trên máy họ. Redis mới của bạn sẽ lưu dữ liệu bạn tạo. Volume `redis-orders-data` giữ dữ liệu qua các lần dừng và mở lại container đã tạo ở bước 2.

## 6. Chạy lại lần sau

Mở Docker Desktop, sau đó mở CMD trong thư mục ứng dụng và chạy.

```cmd
docker start redis-orders
npm start
```

Nếu trang chưa mở được, kiểm tra Redis bằng `docker exec redis-orders redis-cli ping` và xem kết nối từ web ở [trang kiểm tra](http://localhost:3000/api/health). Khi dùng xong, nhấn **Ctrl+C** trong CMD để dừng web.
