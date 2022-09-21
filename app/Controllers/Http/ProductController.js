'use strict'

const Database = use('Database');
const axios = require('axios');
const moment = require('moment');

const APIKEY = 'DwsnRwMfB0l56rw62tAitUvNmBdIQ2bN34VK8TUzs6k'; /* PRODUCCION */
// const APIKEY = 'FrguR1kDpFHaXHLQwplZ2CwTX3p8p9XHVTnukL98V5U'; /* PRUEBAS */

const IDBodega = '001'; /* PRODUCCION */
// const IDBodega = 'SFT001'; /* PRUEBAS */

const URLprod = 'https://api.contifico.com/sistema/api/v1/producto/'; /* PRODUCCION */
// const URLprod = 'https://api.contifico.com/sistema/api/v1/producto/onPeE9p43Dc5Xep1'; /* PRUEBAS */

const URLbodega = 'https://api.contifico.com/sistema/api/v1/bodega/';
const URLmovInv = 'https://api.contifico.com/sistema/api/v1/movimiento-inventario/';


class ProductController {

  async getProducts({
    response
  }) {
    try {
      // Consulta productos de WordPress
      const productos = await Database.raw("SELECT p.ID, p.post_title as name, p.post_status as status, p.post_parent, x.meta_value as stock, y.meta_value as SKU FROM wp_posts p INNER JOIN wp_postmeta x ON x.post_id = p.ID AND x.meta_key = '_stock' LEFT JOIN wp_postmeta y ON y.post_id = p.ID AND y.meta_key = '_sku' WHERE p.post_parent=0 AND p.post_type = 'product_variation' OR p.post_type = 'product' AND p.post_status = 'publish'");

      console.log('Productos en WordPress :>> ', productos[0].length);
      //   Consulta productos de CONTIFICO
      let data = [];

      await axios.get(URLprod, {
        headers: {
          'Authorization': APIKEY
        }
      }).then(res => {
        console.log('Productos en Contifico :>> ', res.data.length);
        if (res.data.length) {
          data = res.data;
        } else {
          data = [res.data];
        }
      }).catch(async error => {
        console.error(error);
        await Database.raw(`INSERT INTO wp_logs (descripcion, stock_ant, stock, tipo_mov) VALUES ('${error}','0','0','ERROR')`);
      });


      /* recorre productos de CONTIFICO */
      for await (const CTFC of data) {
        let qtyCTFC = Number(CTFC.cantidad_stock);
        let idCTFC = CTFC.id;
        let bodega = '';
        let name = CTFC.nombre.toUpperCase();
        let pctjIVA = 1 + (CTFC.porcentaje_iva / 100);
        let price = CTFC.pvp1 * pctjIVA;

        const prodFind = productos[0].find(prod => prod.SKU == CTFC.codigo);

        if (prodFind) {
          console.log('Producto encontrado :>> ', prodFind);
          let id = prodFind.ID;
          let qtyWP = Number(prodFind.stock);

          console.log(`Mostrando producto: ${id}`);
          //pregunto si hay venta en wp con el id_post
          const ventas = await Database.raw(`SELECT o.order_id, om.meta_key, om.meta_value
            FROM wp_woocommerce_order_items o
            JOIN wp_woocommerce_order_itemmeta om on om.order_item_id = o.order_item_id AND o.order_item_type = 'line_item'
            JOIN wp_wc_order_stats ws on ws.order_id = o.order_id
            WHERE (om.meta_key = '_product_id' AND om.meta_value = ${id})
            or (om.meta_key = '_qty')
            AND ws.status='wc-completed' AND o.checked = false;`);

          const venta = ventas[0].find(x => x.meta_key == '_qty')
          console.log('venta :>> ', venta);

          if (venta) {
            let existe = false;
            let qty = 0;
            let order_id = 0;
            for await (const venta of ventas[0]) {
              // console.log(venta);
              if (venta.meta_key === '_product_id' && venta.meta_value == id) existe = true;
              if (existe) {
                if (venta.meta_key == '_qty') {
                  qty = venta.meta_value
                  order_id = venta.order_id
                }
              }
            }

            //pregunta si existe una venta en WP
            if (qty > 0) {
              /* venta realizada en WP, se procede con la generacion de orden de egreso */

              console.log('CONTIFICO', qtyCTFC);
              console.log('WP', qtyWP);

              let diff = qtyCTFC - qtyWP;
              let newStock = qtyCTFC - diff;

              await axios.get(URLbodega, {
                headers: {
                  'Authorization': APIKEY
                }
              }).then(async respBodega => {
                for await (const x of respBodega.data) {
                  if (x.codigo == IDBodega) {
                    bodega = x.id
                  }
                }
              }).catch(async error => {
                await Database.raw(`INSERT INTO wp_logs (descripcion, stock_ant, stock, tipo_mov) VALUES ('${error}','0','0','ERROR')`);
                console.error(error);
              });

              let dataEgreso = {
                "tipo": "EGR",
                "fecha": moment().format('DD/MM/YYYY'),
                "bodega_id": bodega,
                "detalles": [{
                  "producto_id": idCTFC,
                  "cantidad": diff
                }],
                "descripcion": "Egreso por venta web del dia " + moment().format('DD-MM-YYYY')
              };

              console.log('dataEgreso', dataEgreso);

              await axios.post(URLmovInv,
                dataEgreso, {
                  headers: {
                    'Authorization': APIKEY
                  }
                }
              ).then(async postResp => {
                let txtResp = `EGRESO REGISTRADO. CODIGO: ${postResp.data.codigo} FECHA: ${postResp.data.fecha}`;
                await Database.raw(`INSERT INTO wp_logs (descripcion, stock_ant, stock, tipo_mov) VALUES ('${txtResp}','${qtyCTFC}','${newStock}','VENTA')`);
                // console.log(txtResp);
              }).catch(async err => {
                console.log(err);
                await Database.raw(`INSERT INTO wp_logs (descripcion, stock_ant, stock, tipo_mov) VALUES ('${err}','0','0','ERROR')`);
              })

              await Database.raw(`UPDATE wp_postmeta SET meta_value = '${price}' WHERE post_id = ${id} AND meta_key = '_price'`);
              await Database.raw(`UPDATE wp_postmeta SET meta_value = '${price}' WHERE post_id = ${id} AND meta_key = '_regular_price'`);
              await Database.raw(`UPDATE wp_posts SET post_title = '${name}' WHERE ID = ${id}`);

              /* se cambia el checked */
              await Database.raw(`UPDATE wp_woocommerce_order_items SET checked = true WHERE order_id = ${order_id};`);

            }
          } else {
            // if (existe) {
            console.log('else');
            /* venta a través de Contifico, se procede con la actualizacion de stock, nombre y precio en WP */
            await Database.raw(`UPDATE wp_postmeta SET meta_value = '${qtyCTFC}' WHERE post_id = ${id} AND meta_key = '_stock'`);
            await Database.raw(`UPDATE wp_postmeta SET meta_value = '${price}' WHERE post_id = ${id} AND meta_key = '_price'`);
            await Database.raw(`UPDATE wp_postmeta SET meta_value = '${price}' WHERE post_id = ${id} AND meta_key = '_regular_price'`);
            await Database.raw(`UPDATE wp_posts SET post_title = '${name}' WHERE ID = ${id}`);

            /* se registra en LOG */
            let txt = `ACTUALIZACION DE RUTINA. PRODUCTO: ${id}`
            await Database.raw(`INSERT INTO wp_logs (descripcion, stock_ant, stock, tipo_mov) VALUES ('${txt}','${qtyCTFC}','${qtyCTFC}','RUTINA')`);
            console.log("ACTUALIZACION REALIZADA");


          }
        }

      }

      return response.status(200).send("ACTUALIZACION COMPLETADA");

    } catch (error) {
      console.log("error: ", error);
      await Database.raw(`INSERT INTO wp_logs (descripcion, stock_ant, stock, tipo_mov) VALUES ('${error}','0','0','ERROR')`);
      return error;
    }
  }

}

module.exports = ProductController
