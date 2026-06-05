# Mongolagent — Ажлын дүрэм

## Энэ файлын тухай
Энэ бол 2 developer хамтран ажиллах Mongolagent төслийн дүрэм. **Уншиж дуусаад ажил эхэл** — дундаас орж ажиллахгүй.

## Төслийн бүтэц
Mongolagent нь 4 тусдаа repo-оос бүрдэнэ:
- `mongolagent-app` — Mobile / React Native app
- `mongolagent-web` — Вэбсайт (landing page)
- `mongolagent-backend` — API сервер
- `mongolagent-admin` — Admin dashboard

## Хэн юу хийх вэ
Ажил эхлэхдээ нөгөө developer-тэйгээ **яг аль feature-г хэн хийх талаар тохирсоны дараа** branch үүсгэж эхэл. Нэгэн зэрэг нэг файлд хүрэхгүй байхыг хичээ.



## Branch Strategy

```
master   ← Production (живой сайт) — шууд push ХОРИОТОЙ
develop  ← Хоёр developer-н нийлүүлэх газар
feature/ ← Тус тусын ажлын branch
```

## Өдөр тутмын flow

### Шинэ ажил эхлэхэд
```bash
git checkout develop
git pull origin develop          # Сүүлийн кодыг татах
git checkout -b feature/ажлын-нэр
```

### Ажил дууссан
```bash
git add .
git commit -m "feat: тайлбар"
git push origin feature/ажлын-нэр
# GitHub дээр Pull Request үүсгэ → develop branch-д merge хий
```

### Release хийхэд
```bash
# develop → master PR үүсгэж merge хийнэ
```

## Commit message дүрэм

```
feat: шинэ feature нэмсэн
fix: bug зассан
refactor: код цэвэрлэсэн
style: UI өөрчилсөн
docs: баримт бичиг
```

## Чухал анхааруулга

- `master` branch-д шууд push хийхгүй — заавал PR-ээр дамжуулна
- Ажил эхлэхийн өмнө `git pull origin develop` хийж сүүлийн кодыг татна
- Нэг feature = нэг branch = нэг PR
