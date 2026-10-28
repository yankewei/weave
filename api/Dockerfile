FROM php:8.5-cli-alpine

RUN apk add --no-cache libpq \
    && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS linux-headers postgresql-dev \
    && docker-php-ext-install pcntl pgsql \
    && apk del .build-deps
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --no-progress --no-autoloader
COPY bin bin
COPY src src
RUN composer dump-autoload --no-dev --classmap-authoritative

ENV API_HOST=0.0.0.0 API_PORT=8080
EXPOSE 8080
USER www-data
CMD ["php", "-d", "zend.assertions=-1", "bin/server.php"]
