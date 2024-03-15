import fs from "fs"
import jsdom from "jsdom"
import moment from 'moment'
import userAgent from "random-useragent"
import TelegramBot from 'node-telegram-bot-api';

const rawconf = fs.readFileSync('config.json');
const conf = JSON.parse(rawconf);
const bot = new TelegramBot(conf.token);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRandom(max) {
  return Math.floor(Math.random() * max);
}

async function getCookies(){
  const response = await fetch("https://comedores.unr.edu.ar/", {"body": null,"method": "GET"});
  return response.headers.getSetCookie();
}

// Funcion para validar la cookie en el servidor
async function login(cookie){
  let formdata = new FormData();
  formdata.append("form-login[dni]", conf.dni);
  formdata.append("form-login[clave]", conf.clave);
  formdata.append("botones[botonEnviar]", "");
  
  const res = await fetch("https://comedores.unr.edu.ar/", {
    "headers": {
      "Cookie": cookie,
    },
    "body": formdata,
    "method": "POST"
  });

  let response = res.status;
  console.log("Cookie Validation status:", response);
}

async function getReservas(cookies, comedor){
  const response = await fetch("https://comedores.unr.edu.ar/comedor-reserva/buscar-turnos-reservas", {
    "headers": {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "cookie": cookies,
    },
    // Nota: Jquery serializa mal los datos del body en URIencoding y lo usan para hacer esta request en el front, 
    // por lo que el servidor espera un "+" donde por especificacion seria un "%2B", esto lo arregla el replaceAll
    "body": `json=${encodeURIComponent(JSON.stringify({ servicio: comedor, fecha: `${moment().format("YYYY-MM-DD")}+00:00:00` })).replaceAll("%2B", "+")}`,
    "method": "POST"
  });
  
  console.log(`getReservas '${comedor.comedor.nombre.replaceAll("+"," ")} ${comedor.horaInicio}-${comedor.horaFin}' status:`, response.status, "Para llevar:", comedor.paraLlevar);
  const res = await response.json();

  // Revisa si la semana no se pasa de mes
  // Nota: esto solo se lanza si al momento de correr el bot falta menos de una semana para el cambio de mes
  if(moment().format("YYYY-MM") < moment().add(1, "w").format("YYYY-MM")){
    const responseNextMonth = await fetch("https://comedores.unr.edu.ar/comedor-reserva/buscar-turnos-reservas", {
    "headers": {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "cookie": cookies,
    },
    // Nota: Jquery serializa mal los datos del body en URIencoding y lo usan para hacer esta request en el front, 
    // por lo que el servidor espera un "+" donde por especificacion seria un "%2B", esto lo arregla el replaceAll
    "body": `json=${encodeURIComponent(JSON.stringify({ servicio: comedor, fecha: `${moment().add(1, "M").format("YYYY-MM-DD")}+00:00:00` })).replaceAll("%2B", "+")}`,
    "method": "POST"
    });
  
    const resNextMonth = await responseNextMonth.json();
    const values = await Promise.all([res, resNextMonth]);
    // Esto esta asi de asqueroso porque el concat no anda adentro de objetos
    return {turnos: values[0].turnos.concat(values[1].turnos)};
  }
  
  return res;
}

async function getComedores(cookies, params){
  const response = await fetch("https://comedores.unr.edu.ar/comedor-reserva/reservar", {
    "headers": { "cookie": cookies },
    "body": null,
    "method": "GET"
  });

  if(response.status != 200){
    console.log("Incapaz de obtener comedores Status:", response.status);
    return;
  } else{
    console.log("Comedores Status:", response.status);
  }
  
  const dom = new jsdom.JSDOM( await response.text() );
  const scriptText = dom.window.document.querySelector("body > div > div.main-panel > div > div > script:last-child").textContent;
  const json = JSON.parse(scriptText.substring(21, scriptText.length - 2)).comedores;
  
  let comedoresArray = [];

  for(const param of params){
    for (const comedor of json){
      if(comedor.nombre == param.nombre){
        for (const servicio of comedor.servicios){
          if (servicio.horaInicio.horaCorta == param.horaInicio && servicio.paraLlevar == param.paraLlevar && servicio.tipo.nombre == param.comida){
            //Swap horas
            servicio.horaInicio = servicio.horaInicio.horaCorta;
            servicio.horaFin = servicio.horaFin.horaCorta;
            //Limpieza Strings
            servicio.comedor.nombre = servicio.comedor.nombre.replaceAll(" ", "+");
            servicio.nombre = servicio.nombre.replaceAll(" ", "+");
            servicio.fechaVigenciaDesde.mysql = servicio.fechaVigenciaDesde.mysql.replaceAll(" ", "+");
            servicio.horario = servicio.horario.replaceAll(" ", "+");
            //Listo para enviar
            comedoresArray.push({body: servicio, dias: param.dias});
          };
        };
      };
    };
  };

  return comedoresArray
}

async function hacerPedidos(pedidos, cookies, dias){
  for (const element of pedidos.turnos){
    if(element.reserva == null 
      && element.fecha.fechaMysql >= moment().format("YYYY-MM-DD") 
      && dias.includes(element.fecha.diaNombre.slice(0,2))
      ){
      const response = await fetch("https://comedores.unr.edu.ar/comedor-reserva/guardar-reserva", {
        "headers": {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "cookie": cookies,
          "userAgent": userAgent.getRandom()
        },
        "body": `turno=${element.id}`,
        "method": "POST"
      });

      console.log("\x1b[32m[REQUEST]\x1b[0m ID:", element.id, element.fecha.fecha, "Status:", response.status, element.servicio.comedor.nombre, element.servicio.horaInicio.horaCorta, "-", element.servicio.horaFin.horaCorta, "ParaLlevar:", element.servicio.paraLlevar, "Date:", Date());
      await sleep(10000);
    }
  };
}

//Main loop
const cookies = await getCookies();
console.log(cookies);
await login(cookies);

const comedoresArray = await getComedores(cookies, conf.comedores);

for(const comedor of comedoresArray){
  let reserva = await getReservas(cookies, comedor.body);

  if(conf.concurrent){
    const request = setInterval(async () => {
      if(!(reserva.turnos.some(turno => turno.reserva == null && `${turno.fecha.fechaMysql} ${turno.servicio.horaFin.hora}` >= moment().format("YYYY-MM-DD HH:mm:ss")))){
        console.log(`Reservas no disponibles '${comedor.body.comedor.nombre.replaceAll("+"," ")} ${comedor.body.horaInicio}-${comedor.body.horaFin}' Para llevar: ${comedor.body.paraLlevar}`, Date());
        reserva = await getReservas(cookies, comedor.body);
      } else{
        await hacerPedidos(reserva, cookies, comedor.dias);
        
        if(comedor.body.comedor.nombre === "Comedor+Universitario+FCEIA"){
          bot.sendMessage(param.channel, "Abrio el comedor culiau");    
        }
        
        clearInterval(request);
      }
    }, conf.sleepTime + getRandom(conf.maxRandomTime));  
  } else {
    while(!(reserva.turnos.some(turno => turno.reserva == null && `${turno.fecha.fechaMysql} ${turno.servicio.horaFin.hora}` >= moment().format("YYYY-MM-DD HH:mm:ss") ))){
      console.log(`Reservas no disponibles '${comedor.body.comedor.nombre.replaceAll("+"," ")} ${comedor.body.horaInicio}-${comedor.body.horaFin}' Para llevar: ${comedor.body.paraLlevar}`, Date());
      await sleep(conf.sleepTime + getRandom(conf.maxRandomTime));
      reserva = await getReservas(cookies, comedor.body);
    }

    await hacerPedidos(reserva, cookies, comedor.dias);
    if(comedor.body.comedor.nombre === "Comedor+Universitario+FCEIA"){
      bot.sendMessage(param.channel, "Abrio el comedor culiau");    
    } 
  }
} 
