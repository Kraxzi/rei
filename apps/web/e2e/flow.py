# End-to-end check with a virtual passkey (Chrome DevTools WebAuthn).
# Needs a fresh local DB with BOOTSTRAP_CODE=TEST-CODE-1 in apps/api/.dev.vars and `wrangler dev` on :8787.
# Run from apps/web: python3 e2e/flow.py
import asyncio, sys
from playwright.async_api import async_playwright

import os
BASE = os.environ.get('REI_URL', 'http://localhost:8787')
os.makedirs('e2e/screenshots', exist_ok=True)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 360, 'height': 844}, device_scale_factor=2, locale='ru-RU')
        page = await ctx.new_page()
        errors = []
        page.on('response', lambda r: errors.append((r.status, r.url)) if r.status >= 400 else None)
        cdp = await ctx.new_cdp_session(page)
        await cdp.send('WebAuthn.enable')
        await cdp.send('WebAuthn.addVirtualAuthenticator', {'options': {'protocol': 'ctap2', 'transport': 'internal', 'hasResidentKey': True, 'hasUserVerification': True, 'isUserVerified': True}})

        await page.goto(BASE)
        await page.wait_for_selector('text=Первый вход')
        await page.screenshot(path='e2e/screenshots/01-bootstrap.png')
        await page.fill('input[autocomplete=name]', 'Батя')
        await page.fill('input[autocomplete=one-time-code]', 'test-code-1')
        await page.click('text=Создать вход по отпечатку')
        await page.wait_for_selector('text=Здравствуйте, Батя', timeout=15000)
        await page.screenshot(path='e2e/screenshots/02-home.png')

        # new search profile
        await page.click('a:has-text("Поиски")')
        await page.click('text=Новый поиск')
        await page.wait_for_selector('text=Регионы Италии')
        await page.fill('input[placeholder="Например, гаражи на побережье"]', 'Гаражи на Ривьере')
        await page.click('button.chip:has-text("Liguria")')
        await page.wait_for_selector('text=Провинции Лигурии')
        await page.click('button.chip:has-text("Imperia")')
        await page.click('button.chip:has-text("Индивидуальный гараж")')
        await page.click('button.chip:has-text("Парковочное место")')
        await page.locator('label:has-text("Цена до") input').fill('40 000')
        await page.locator('label:has-text("Чистая доходность не ниже") input').fill('6')
        await page.screenshot(path='e2e/screenshots/03-profile-form.png', full_page=True)
        await page.click('text=Сохранить поиск')
        await page.wait_for_selector('text=Гаражи на Ривьере')
        await page.screenshot(path='e2e/screenshots/04-profiles.png')

        # calculator
        await page.click('a:has-text("Расчёт")')
        await page.select_option('select', 'garage')
        await page.locator('label:has-text("Количество мест") input').fill('1')
        await page.locator('label:has-text("Аренда одного места в месяц") input').fill('120')
        await page.locator('label:has-text("Загрузка") input').fill('92')
        await page.locator('label:has-text("Цена покупки") input').fill('28 000')
        await page.locator('label:has-text("Налог на покупку") input').fill('9')
        await page.locator('label:has-text("Нотариус") input').fill('1 500')
        await page.click('summary:has-text("Расходы владения")')
        await page.locator('label:has-text("Страховка в год") input').fill('80')
        await page.locator('label:has-text("Налог на владение") input').fill('200')
        await page.locator('label:has-text("Обслуживание и кондоминиум") input').fill('50')
        await page.click('button:has-text("Посчитать")')
        await page.wait_for_selector('#result')
        await page.wait_for_timeout(600)
        hero = await page.inner_text('.hero-figure')
        print('HERO', hero)
        await page.locator('#result').screenshot(path='e2e/screenshots/05-result.png')

        # logout + passkey login
        await page.click('a:has-text("Ещё")')
        await page.wait_for_selector('text=Устройства для входа')
        await page.screenshot(path='e2e/screenshots/06-more.png', full_page=True)
        await page.click('button:has-text("Выйти")')
        await page.wait_for_selector('button:has-text("Войти")')
        await page.screenshot(path='e2e/screenshots/07-login.png')
        await page.click('button:has-text("Войти")')
        await page.wait_for_selector('text=Здравствуйте, Батя', timeout=15000)
        print('LOGIN OK')
        await page.set_viewport_size({'width': 1280, 'height': 900})
        await page.click('a:has-text("Расчёт")')
        await page.screenshot(path='e2e/screenshots/08-desktop.png')
        print('CONSOLE ERRORS', errors)
        await b.close()
asyncio.run(main())
